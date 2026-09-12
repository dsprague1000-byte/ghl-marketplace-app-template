import qs from "qs";
import axios, { AxiosRequestConfig, InternalAxiosRequestConfig } from "axios";
import { createDecipheriv, createHash } from 'node:crypto';

import { Model, TokenType } from "./model";

/* The GHL class is responsible for handling authorization, making API requests, and managing access
tokens and refresh tokens for a specific resource. */
export class GHL {
  public model: Model;

  constructor() {
    this.model = new Model();
  }

  async initialize() {
    const hydratedCount = await this.model.initialize();

    // Company OAuth grants are authoritative for permissions. Location grants are derived from the
    // Company token, so re-derive persisted Location tokens after hydration to prevent stale scopes
    // surviving a Company reauthorization (P027A exposed this when record.write was added).
    const companyInstallations = Object.entries(this.model.installationObjects)
      .filter(([, installation]) => installation.userType === "Company");
    const locationIds = Object.entries(this.model.installationObjects)
      .filter(([, installation]) => installation.userType === "Location")
      .map(([resourceId]) => resourceId);

    for (const [companyId] of companyInstallations) {
      for (const locationId of locationIds) {
        await this.getLocationTokenFromCompanyToken(companyId, locationId);
      }
    }

    return hydratedCount;
  }

/**
 * The `authorizationHandler` function handles the authorization process by generating an access token
 * and refresh token pair.
 */
  async authorizationHandler(code: string) {
    if (!code) {
      console.warn(
        "Please provide code when making call to authorization Handler"
      );
    }
    await this.generateAccessTokenRefreshTokenPair(code);
  }

  decryptSSOData(key: string) {
    try {
      const blockSize = 16;
      const keySize = 32;
      const ivSize = 16;
      const saltSize = 8;
      
      const rawEncryptedData = Buffer.from(key, 'base64');
      const salt = rawEncryptedData.subarray(saltSize, blockSize);
      const cipherText = rawEncryptedData.subarray(blockSize);
      
      let result = Buffer.alloc(0, 0);
      while (result.length < (keySize + ivSize)) {
        const hasher = createHash('md5');
        result = Buffer.concat([
          result,
          hasher.update(Buffer.concat([
            result.subarray(-ivSize),
            Buffer.from(process.env.GHL_APP_SSO_KEY as string, 'utf-8'),
            salt
          ])).digest()
        ]);
      }
      
      const decipher = createDecipheriv(
        'aes-256-cbc',
        result.subarray(0, keySize),
        result.subarray(keySize, keySize + ivSize)
      );
      
      const decrypted = decipher.update(cipherText);
      const finalDecrypted = Buffer.concat([decrypted, decipher.final()]);
      return JSON.parse(finalDecrypted.toString());
    } catch (error) {
      console.error('Error decrypting SSO data:', error);
      throw error;
    }
  }

  requests(resourceId: string) {
    const baseUrl = process.env.GHL_API_DOMAIN;

    if (!this.model.getAccessToken(resourceId)) {
      throw new Error("Installation not found for the following resource");
    }

    const axiosInstance = axios.create({
      baseURL: baseUrl,
    });

    axiosInstance.interceptors.request.use(
      async (requestConfig: InternalAxiosRequestConfig) => {
        requestConfig.headers["Authorization"] = `${
          TokenType.Bearer
        } ${this.model.getAccessToken(resourceId)}`;
        return requestConfig;
      }
    );

    axiosInstance.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
          originalRequest._retry = true;
          await this.refreshAccessToken(resourceId);
          originalRequest.headers.Authorization = `Bearer ${this.model.getAccessToken(
            resourceId
          )}`;
          return axios(originalRequest);
        }

        return Promise.reject(error);
      }
    );

    return axiosInstance;
  }

  checkInstallationExists(resourceId: string){
    return !!this.model.getAccessToken(resourceId)
  }

  async getLocationTokenFromCompanyToken(
    companyId: string,
    locationId: string
  ) {
    const res = await this.requests(companyId).post(
      "/oauth/locationToken",
      {
        companyId,
        locationId,
      },
      {
        headers: {
          Version: "2021-07-28",
        },
      }
    );
    await this.model.saveInstallationInfo(res.data);
    console.log('[P027A-location-token] rederived:', JSON.stringify({
      locationId: res.data.locationId ?? locationId,
      companyId: res.data.companyId ?? companyId,
      userType: res.data.userType ?? null,
      expires_in: res.data.expires_in ?? null,
      scope: res.data.scope ?? null,
    }));
  }

  private async refreshAccessToken(resourceId: string) {
    try {
      const resp = await axios.post(
        `${process.env.GHL_API_DOMAIN}/oauth/token`,
        qs.stringify({
          client_id: process.env.GHL_APP_CLIENT_ID,
          client_secret: process.env.GHL_APP_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: this.model.getRefreshToken(resourceId),
        }),
        { headers: { "content-type": "application/x-www-form-urlencoded" } }
      );

      await this.model.updateTokenPair(
        resourceId,
        resp.data.access_token,
        resp.data.refresh_token,
        resp.data.expires_in
      );
    } catch (error: any) {
      console.error("[P019A-refresh]", {
        status: error?.response?.status ?? null,
        message: error?.message ?? "unknown",
      });
      throw error;
    }
  }

  private async generateAccessTokenRefreshTokenPair(code: string) {
    try {
      const resp = await axios.post(
        `${process.env.GHL_API_DOMAIN}/oauth/token`,
        qs.stringify({
          client_id: process.env.GHL_APP_CLIENT_ID,
          client_secret: process.env.GHL_APP_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          user_type: "Location",
          redirect_uri: "https://mpp-auth-context-probe.onrender.com/oauth/callback",
        }),
        { headers: { "content-type": "application/x-www-form-urlencoded" } }
      );

      await this.model.saveInstallationInfo(resp.data);

      console.log('[P018-diag] exchange success:', JSON.stringify({
        http_status: resp.status,
        token_present: !!resp.data.access_token,
        expires_in: resp.data.expires_in ?? null,
        locationId: resp.data.locationId ?? null,
        companyId: resp.data.companyId ?? null,
        userType: resp.data.userType ?? null,
        response_keys: Object.keys(resp.data),
        stored_key: resp.data.locationId || resp.data.companyId || null,
      }));
    } catch (error: any) {
      if (error?.response) {
        console.error('[P018-diag] exchange HTTP error:', JSON.stringify({
          status: error.response.status,
          error: error.response.data?.error,
          error_description: error.response.data?.error_description,
        }));
      } else {
        console.error('[P018-diag] exchange network/config error:', error?.message ?? 'unknown');
      }
      throw error;
    }
  }
}
