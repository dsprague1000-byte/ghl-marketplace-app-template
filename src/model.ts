import {
  initializeOAuthStore,
  updateOAuthTokenPair,
  upsertOAuthInstallation,
} from "./db";

export enum AppUserType {
  Company = "Company",
  Location = "Location",
}

export enum TokenType {
  Bearer = "Bearer",
}

export interface InstallationDetails {
  access_token: string;
  token_type: TokenType.Bearer;
  expires_in: number;
  refresh_token: string;
  scope: string;
  userType: AppUserType;
  companyId?: string;
  locationId?: string;
}

/* The Model class is responsible for saving and retrieving installation details, access tokens, and
refresh tokens. Postgres is authoritative; installationObjects is the in-process cache. */
export class Model {
  public installationObjects: { [key: string]: InstallationDetails } = {};

  async initialize() {
    const rows = await initializeOAuthStore();
    this.installationObjects = {};

    for (const row of rows) {
      const expiresAt = new Date(row.expires_at).getTime();
      const expiresIn = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));

      this.installationObjects[row.resource_id] = {
        access_token: row.access_token,
        token_type: TokenType.Bearer,
        expires_in: expiresIn,
        refresh_token: row.refresh_token,
        scope: "",
        userType: row.user_type as AppUserType,
        companyId: row.company_id ?? undefined,
        locationId: row.location_id ?? undefined,
      };
    }

    return rows.length;
  }

/**
 * Persist installation information before adding it to the in-memory cache.
 */
  async saveInstallationInfo(details: InstallationDetails) {
    const resourceId = details.locationId || details.companyId;
    if (!resourceId) {
      throw new Error("OAuth installation is missing resource ID");
    }
    if (!details.access_token || !details.refresh_token) {
      throw new Error("OAuth installation is missing token pair");
    }

    const resourceType = details.locationId ? "location" : "company";
    const expiresAt = new Date(Date.now() + details.expires_in * 1000);

    await upsertOAuthInstallation({
      resourceId,
      resourceType,
      companyId: details.companyId,
      locationId: details.locationId,
      userType: details.userType,
      accessToken: details.access_token,
      refreshToken: details.refresh_token,
      expiresAt,
    });

    this.installationObjects[resourceId] = details;
  }

  getAccessToken(resourceId: string) {
    return this.installationObjects[resourceId]?.access_token;
  }

  getRefreshToken(resourceId: string) {
    return this.installationObjects[resourceId]?.refresh_token;
  }

  async updateTokenPair(
    resourceId: string,
    accessToken: string,
    refreshToken: string,
    expiresIn: number
  ) {
    const installation = this.installationObjects[resourceId];
    if (!installation) {
      throw new Error("OAuth installation not found during token refresh");
    }

    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    await updateOAuthTokenPair({
      resourceId,
      accessToken,
      refreshToken,
      expiresAt,
    });

    installation.access_token = accessToken;
    installation.refresh_token = refreshToken;
    installation.expires_in = expiresIn;
  }
}
