/*you provided is a TypeScript code that sets up an Express server and defines several routes
for handling HTTP requests. */
import express, { Express, Request, Response } from "express";
import dotenv from "dotenv";
import { GHL } from "./ghl";
import * as CryptoJS from 'crypto-js'
import { json } from "body-parser";
import { getAssignmentRecordId, initializeAssignmentIndex } from "./db";

const path = __dirname + "/ui/dist/";

dotenv.config();
const app: Express = express();
app.use(json({ type: 'application/json' }))

app.use(express.static(path));

const ghl = new GHL();

const port = process.env.PORT;

app.get("/authorize-handler", async (req: Request, res: Response) => {
  const { code } = req.query;
  await ghl.authorizationHandler(code as string);
  res.redirect("https://app.gohighlevel.com/");
});

app.get("/example-api-call", async (req: Request, res: Response) => {
  if (ghl.checkInstallationExists(req.query.companyId as string)) {
    try {
      const request = await ghl
        .requests(req.query.companyId as string)
        .get(`/users/search?companyId=${req.query.companyId}`, {
          headers: { Version: "2021-07-28" },
        });
      return res.send(request.data);
    } catch (error) {
      console.log(error);
    }
  }
  return res.send("Installation for this company does not exists");
});

app.get("/example-api-call-location", async (req: Request, res: Response) => {
  try {
    if (ghl.checkInstallationExists(req.params.locationId)) {
      const request = await ghl
        .requests(req.query.locationId as string)
        .get(`/contacts/?locationId=${req.query.locationId}`, {
          headers: { Version: "2021-07-28" },
        });
      return res.send(request.data);
    } else {
      await ghl.getLocationTokenFromCompanyToken(
        req.query.companyId as string,
        req.query.locationId as string
      );
      const request = await ghl
        .requests(req.query.locationId as string)
        .get(`/contacts/?locationId=${req.query.locationId}`, {
          headers: { Version: "2021-07-28" },
        });
      return res.send(request.data);
    }
  } catch (error) {
    console.log(error);
    res.send(error).status(400)
  }
});

app.post("/example-webhook-handler", async (req: Request, res: Response) => {
  console.log(req.body)
})

app.post("/decrypt-sso", async (req: Request, res: Response) => {
  const {key} = req.body || {}
  if (!key) {
    return res.status(400).send("Please send valid key")
  }
  try {
    const data = ghl.decryptSSOData(key)
    res.send(data)
  } catch (error) {
    res.status(400).send("Invalid Key")
    console.log(error)
  }
})

/* P016: OAuth callback receiver. */
app.get("/oauth/callback", async (req: Request, res: Response) => {
  const { code } = req.query;

  if (!code) {
    return res.status(200).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>MPP OAuth Callback</title></head>
<body><main><h1>MPP OAuth Callback Received</h1>
<p>Authorization code received: No</p><p>You may close this page.</p></main></body></html>`);
  }

  await ghl.authorizationHandler(code as string);

  const locationId = "e44pA2hEK8BXwer0eNYB";
  const tokenStored = ghl.checkInstallationExists(locationId);
  const allKeys = Object.keys(ghl.model.installationObjects);

  if (!tokenStored) {
    return res.status(500).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>MPP OAuth Callback</title></head>
<body><main><h1>MPP OAuth Callback Received</h1>
<p>Authorization code received: Yes</p>
<p>Token exchange/storage: Failed</p>
<p>installationObjectsKeys: ${JSON.stringify(allKeys)}</p>
<p>Check Render logs for [P018-diag] exchange result.</p>
<p>Do not retry yet. Contact the administrator.</p></main></body></html>`);
  }

  return res.status(200).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>MPP OAuth Installation Complete</title></head>
<body><main><h1>MPP OAuth Installation Complete</h1>
<p>Authorization code received: Yes</p>
<p>Token exchange/storage: Complete</p>
<p>Location: ${locationId}</p>
<p>You may close this page.</p></main></body></html>`);
});

app.get("/oauth/token-status", (req: Request, res: Response) => {
  const locationId = "e44pA2hEK8BXwer0eNYB";
  const inst = ghl.model.installationObjects[locationId];
  const allKeys = Object.keys(ghl.model.installationObjects);

  return res.json({
    tokenAvailable: ghl.checkInstallationExists(locationId),
    locationId: inst?.locationId ?? null,
    companyId: inst?.companyId ?? null,
    userType: inst?.userType ?? null,
    expires_in: inst?.expires_in ?? null,
    refreshTokenPresent: !!ghl.model.getRefreshToken(locationId),
    installationObjectsKeys: allKeys,
    storedKey: allKeys.length > 0 ? allKeys[0] : null,
  });
});

/* P017/P019B: Assignment context — resolves MPP role and scope for the authenticated viewer.
   Accepts raw GHL SSO key; derives trusted identity server-side only.
   Never trusts userId or activeLocation sent directly from the browser. */
app.post("/assignment-context", async (req: Request, res: Response) => {
  const { key } = req.body || {};

  if (!key) {
    return res.status(400).json({ error: "SSO key required" });
  }

  let ssoData: any;
  try {
    ssoData = ghl.decryptSSOData(key);
  } catch {
    return res.status(401).json({ error: "Invalid SSO key" });
  }

  const { userId, activeLocation } = ssoData;

  if (!userId || !activeLocation) {
    return res.status(401).json({
      error: "SSO data missing required identity fields",
      ssoKeys: Object.keys(ssoData),
    });
  }

  if (!ghl.checkInstallationExists(activeLocation)) {
    const SPOKE_COMPANY_ID = "NUAR0gljpx3i4RfDQPCf";
    const companyInst = ghl.model.installationObjects[SPOKE_COMPANY_ID];

    if (!companyInst || companyInst.userType !== "Company") {
      return res.status(403).json({
        error: "No OAuth token available for this location",
        activeLocation,
      });
    }

    try {
      await ghl.getLocationTokenFromCompanyToken(
        SPOKE_COMPANY_ID,
        activeLocation
      );
    } catch (err: any) {
      console.error("[P017-token-exchange]", {
        status: err?.response?.status ?? null,
        message: err?.message ?? "unknown",
      });
      return res.status(403).json({
        error: "Location token exchange failed",
        activeLocation,
      });
    }

    if (!ghl.checkInstallationExists(activeLocation)) {
      return res.status(403).json({
        error: "Location token exchange produced no token",
        activeLocation,
      });
    }
  }

  // P019B: Postgres is the persistent locator from trusted identity to GHL record ID.
  // The fetched GHL record remains authoritative and must match the trusted SSO userId.
  let assignmentRecordId: string | null = null;
  try {
    assignmentRecordId = await getAssignmentRecordId(activeLocation, userId);
  } catch (err: any) {
    console.error("[P019B-index-lookup]", {
      message: err?.message ?? "unknown",
    });
    return res.status(500).json({ error: "assignment_index_lookup_failed" });
  }

  if (!assignmentRecordId) {
    return res.json({
      trustedUserId: userId,
      activeLocation,
      tokenVerified: true,
      assignmentFound: false,
      assignment: null,
    });
  }

  let record: any;
  try {
    const recordResp = await ghl
      .requests(activeLocation)
      .get(
        `/objects/custom_objects.mpp_user_assignment/records/${assignmentRecordId}`,
        { headers: { Version: "v3" } }
      );
    record = recordResp.data?.record ?? null;
  } catch (err: any) {
    console.error("[P017-assignment-get]", {
      status: err?.response?.status ?? null,
      message: err?.message ?? "unknown",
    });
    return res.status(500).json({ error: "assignment_lookup_failed" });
  }

  if (!record || record.properties?.ghl_user_id !== userId) {
    return res.json({
      trustedUserId: userId,
      activeLocation,
      tokenVerified: true,
      assignmentFound: false,
      assignment: null,
    });
  }

  return res.json({
    trustedUserId: userId,
    activeLocation,
    tokenVerified: true,
    assignmentFound: true,
    assignment: {
      mpp_role: record.properties?.mpp_role ?? null,
      scope_type: record.properties?.scope_type ?? null,
      active: record.properties?.active ?? null,
      assignment_name: record.properties?.assignment_name ?? null,
      ghl_user_id: record.properties?.ghl_user_id ?? null,
    },
  });
});

app.get("/", function (req, res) {
  res.sendFile(path + "index.html");
});

async function start() {
  try {
    const hydratedCount = await ghl.initialize();
    const assignmentIndexCount = await initializeAssignmentIndex();
    console.log("[P019A] OAuth store ready", { hydratedCount });
    console.log("[P019B] Assignment index ready", { assignmentIndexCount });

    app.listen(port, () => {
      console.log(`GHL app listening on port ${port}`);
    });
  } catch (error: any) {
    console.error("[P019] startup failed", {
      message: error?.message ?? "unknown",
    });
    process.exit(1);
  }
}

start();
