import express, { Express, Request, Response } from "express";
import dotenv from "dotenv";
import { GHL } from "./ghl";
import { json } from "body-parser";
import {
  createShiftLog,
  getAssignmentRecordId,
  getPerformanceRollup,
  getReviewQueue,
  getSellerShiftLogs,
  initializeAssignmentIndex,
  initializePerformanceStore,
  reviewShiftLog,
  upsertAssignmentIndex,
} from "./db";

const path = __dirname + "/ui/dist/";

dotenv.config();
const app: Express = express();
app.use(json({ type: "application/json" }));
app.use(express.static(path));

const ghl = new GHL();
const port = process.env.PORT;
const SPOKE_COMPANY_ID = "NUAR0gljpx3i4RfDQPCf";
const MANAGER_ROLES = new Set([
  "sales_manager",
  "general_manager",
  "regional_manager",
  "owner",
]);
const PROVISION_ROLES = new Set([
  "general_manager",
  "regional_manager",
  "owner",
]);

function isActive(value: unknown) {
  return String(value ?? "").trim().toLowerCase() === "yes";
}

function normalizeRole(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

async function ensureLocationToken(activeLocation: string) {
  if (ghl.checkInstallationExists(activeLocation)) return;

  const companyInst = ghl.model.installationObjects[SPOKE_COMPANY_ID];
  if (!companyInst || companyInst.userType !== "Company") {
    throw Object.assign(new Error("No OAuth token available for this location"), {
      statusCode: 403,
    });
  }

  await ghl.getLocationTokenFromCompanyToken(SPOKE_COMPANY_ID, activeLocation);

  if (!ghl.checkInstallationExists(activeLocation)) {
    throw Object.assign(new Error("Location token exchange produced no token"), {
      statusCode: 403,
    });
  }
}

async function getRecordById(activeLocation: string, recordId: string) {
  const recordResp = await ghl
    .requests(activeLocation)
    .get(
      `/objects/custom_objects.mpp_user_assignment/records/${recordId}`,
      { headers: { Version: "v3" } }
    );

  return recordResp.data?.record ?? null;
}

function decryptTrustedIdentity(key: string) {
  if (!key) {
    throw Object.assign(new Error("SSO key required"), { statusCode: 400 });
  }

  let ssoData: any;
  try {
    ssoData = ghl.decryptSSOData(key);
  } catch {
    throw Object.assign(new Error("Invalid SSO key"), { statusCode: 401 });
  }

  const { userId, activeLocation } = ssoData;
  if (!userId || !activeLocation) {
    throw Object.assign(new Error("SSO data missing required identity fields"), {
      statusCode: 401,
    });
  }

  return { ssoData, userId, activeLocation };
}

async function resolveTrustedAssignment(key: string) {
  const { ssoData, userId, activeLocation } = decryptTrustedIdentity(key);

  await ensureLocationToken(activeLocation);

  const recordId = await getAssignmentRecordId(activeLocation, userId);
  if (!recordId) {
    return { ssoData, userId, activeLocation, assignmentFound: false };
  }

  const record = await getRecordById(activeLocation, recordId);
  if (!record || record.properties?.ghl_user_id !== userId) {
    return { ssoData, userId, activeLocation, assignmentFound: false };
  }

  const assignment = {
    recordId,
    mpp_role: normalizeRole(record.properties?.mpp_role),
    scope_type: String(record.properties?.scope_type ?? "").trim().toLowerCase(),
    active: record.properties?.active ?? null,
    assignment_name: record.properties?.assignment_name ?? null,
    ghl_user_id: record.properties?.ghl_user_id ?? null,
  };

  return {
    ssoData,
    userId,
    activeLocation,
    assignmentFound: true,
    assignment,
  };
}

function sendSafeError(res: Response, error: any, fallback = "request_failed") {
  const status = error?.statusCode ?? 500;
  console.error("[MPP] request error", {
    status,
    message: error?.message ?? "unknown",
  });
  return res.status(status).json({ error: error?.message ?? fallback });
}

app.get("/authorize-handler", async (req: Request, res: Response) => {
  const { code } = req.query;
  await ghl.authorizationHandler(code as string);
  res.redirect("https://app.gohighlevel.com/");
});

app.post("/decrypt-sso", async (req: Request, res: Response) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).send("Please send valid key");

  try {
    return res.send(ghl.decryptSSOData(key));
  } catch {
    console.error("[MPP] decrypt-sso failed", { message: "Invalid Key" });
    return res.status(400).send("Invalid Key");
  }
});

app.get("/oauth/callback", async (req: Request, res: Response) => {
  const { code } = req.query;

  if (!code) {
    return res.status(200).send(`<!doctype html><html><body><main>
      <h1>MPP OAuth Callback Received</h1>
      <p>Authorization code received: No</p>
      <p>You may close this page.</p>
    </main></body></html>`);
  }

  try {
    await ghl.authorizationHandler(code as string);
    const allKeys = Object.keys(ghl.model.installationObjects);
    return res.status(200).send(`<!doctype html><html><body><main>
      <h1>MPP OAuth Installation Complete</h1>
      <p>Authorization code received: Yes</p>
      <p>Token exchange/storage: Complete</p>
      <p>Stored OAuth contexts: ${allKeys.length}</p>
      <p>You may close this page.</p>
    </main></body></html>`);
  } catch (error: any) {
    console.error("[MPP] OAuth callback failed", {
      message: error?.message ?? "unknown",
    });
    return res.status(500).send(`<!doctype html><html><body><main>
      <h1>MPP OAuth Callback Received</h1>
      <p>Authorization code received: Yes</p>
      <p>Token exchange/storage: Failed</p>
      <p>Contact the administrator.</p>
    </main></body></html>`);
  }
});

app.get("/oauth/token-status", (_req: Request, res: Response) => {
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

/* P021: trusted viewer context + role/capabilities for the MPP shell. */
app.post("/assignment-context", async (req: Request, res: Response) => {
  try {
    const resolved: any = await resolveTrustedAssignment(req.body?.key);

    if (!resolved.assignmentFound) {
      return res.json({
        trustedUserId: resolved.userId,
        activeLocation: resolved.activeLocation,
        tokenVerified: true,
        assignmentFound: false,
        assignment: null,
        capabilities: [],
      });
    }

    const role = resolved.assignment.mpp_role;
    const active = isActive(resolved.assignment.active);
    const capabilities = active
      ? [
          "view_shell",
          ...(role === "seller" ? ["submit_shift", "view_self"] : []),
          ...(MANAGER_ROLES.has(role) ? ["view_location", "review_logs"] : []),
          ...(PROVISION_ROLES.has(role) ? ["provision_assignments"] : []),
        ]
      : [];

    return res.json({
      trustedUserId: resolved.userId,
      activeLocation: resolved.activeLocation,
      tokenVerified: true,
      assignmentFound: true,
      assignment: resolved.assignment,
      capabilities,
    });
  } catch (error: any) {
    return sendSafeError(res, error, "assignment_lookup_failed");
  }
});

/* P020: provision an existing GHL MPP User Assignment record.
   Bootstrap mode: an unindexed viewer may provision only the active record whose
   GHL User ID exactly matches the trusted SSO userId. This creates a safe first
   index entry without a privileged seed.
   Admin mode: an already-indexed GM/RM/Owner may provision another user's record. */
app.post("/admin/assignment-provision", async (req: Request, res: Response) => {
  try {
    const { key, recordId } = req.body || {};
    if (!recordId || typeof recordId !== "string") {
      return res.status(400).json({ error: "recordId required" });
    }

    const identity = decryptTrustedIdentity(key);
    await ensureLocationToken(identity.activeLocation);

    const targetRecord = await getRecordById(identity.activeLocation, recordId);
    const targetUserId = targetRecord?.properties?.ghl_user_id;
    if (!targetRecord || !targetUserId) {
      return res.status(400).json({ error: "Target assignment record is invalid" });
    }
    if (!isActive(targetRecord.properties?.active)) {
      return res.status(400).json({ error: "Target assignment record is inactive" });
    }

    const existingCallerRecordId = await getAssignmentRecordId(
      identity.activeLocation,
      identity.userId
    );

    let mode: "self" | "admin" = "self";

    if (!existingCallerRecordId) {
      if (targetUserId !== identity.userId) {
        return res.status(403).json({
          error: "Self-provisioning requires your own assignment record",
        });
      }
    } else {
      const caller: any = await resolveTrustedAssignment(key);
      if (!caller.assignmentFound || !isActive(caller.assignment.active)) {
        return res.status(403).json({ error: "Active MPP assignment required" });
      }
      if (!PROVISION_ROLES.has(caller.assignment.mpp_role)) {
        return res.status(403).json({ error: "Assignment provisioning not permitted" });
      }
      mode = "admin";
    }

    await upsertAssignmentIndex(identity.activeLocation, targetUserId, recordId);

    return res.json({
      provisioned: true,
      mode,
      locationId: identity.activeLocation,
      recordId,
      assignment: {
        assignment_name: targetRecord.properties?.assignment_name ?? null,
        ghl_user_id: targetUserId,
        mpp_role: normalizeRole(targetRecord.properties?.mpp_role),
        scope_type: targetRecord.properties?.scope_type ?? null,
        active: targetRecord.properties?.active ?? null,
      },
    });
  } catch (error: any) {
    return sendSafeError(res, error, "assignment_provision_failed");
  }
});

/* P022: seller shift/activity submission. */
app.post("/seller/shift-log", async (req: Request, res: Response) => {
  try {
    const { key, shiftDate, opportunities, membershipsSold, notes } = req.body || {};
    const viewer: any = await resolveTrustedAssignment(key);

    if (!viewer.assignmentFound || !isActive(viewer.assignment.active)) {
      return res.status(403).json({ error: "Active MPP assignment required" });
    }
    if (viewer.assignment.mpp_role !== "seller") {
      return res.status(403).json({ error: "Seller role required" });
    }

    const opp = Number(opportunities);
    const sold = Number(membershipsSold);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(shiftDate ?? ""))) {
      return res.status(400).json({ error: "Valid shiftDate required" });
    }
    if (!Number.isInteger(opp) || opp < 0 || !Number.isInteger(sold) || sold < 0) {
      return res.status(400).json({ error: "Counts must be non-negative integers" });
    }
    if (sold > opp) {
      return res.status(400).json({ error: "membershipsSold cannot exceed opportunities" });
    }

    const log = await createShiftLog({
      locationId: viewer.activeLocation,
      sellerUserId: viewer.userId,
      sellerName: viewer.assignment.assignment_name || viewer.ssoData.userName || "Seller",
      assignmentRecordId: viewer.assignment.recordId,
      shiftDate,
      opportunities: opp,
      membershipsSold: sold,
      notes: String(notes ?? "").slice(0, 2000),
    });

    return res.status(201).json({ created: true, log });
  } catch (error: any) {
    return sendSafeError(res, error, "shift_log_create_failed");
  }
});

app.post("/seller/shift-logs", async (req: Request, res: Response) => {
  try {
    const viewer: any = await resolveTrustedAssignment(req.body?.key);
    if (!viewer.assignmentFound || !isActive(viewer.assignment.active)) {
      return res.status(403).json({ error: "Active MPP assignment required" });
    }

    const logs = await getSellerShiftLogs(viewer.activeLocation, viewer.userId, 30);
    return res.json({ logs });
  } catch (error: any) {
    return sendSafeError(res, error, "shift_log_list_failed");
  }
});

/* P023: manager verification queue. */
app.post("/manager/review-queue", async (req: Request, res: Response) => {
  try {
    const viewer: any = await resolveTrustedAssignment(req.body?.key);
    if (!viewer.assignmentFound || !isActive(viewer.assignment.active)) {
      return res.status(403).json({ error: "Active MPP assignment required" });
    }
    if (!MANAGER_ROLES.has(viewer.assignment.mpp_role)) {
      return res.status(403).json({ error: "Manager role required" });
    }

    const logs = await getReviewQueue(viewer.activeLocation);
    return res.json({ logs });
  } catch (error: any) {
    return sendSafeError(res, error, "review_queue_failed");
  }
});

app.post("/manager/review-shift", async (req: Request, res: Response) => {
  try {
    const { key, logId, decision } = req.body || {};
    const viewer: any = await resolveTrustedAssignment(key);
    if (!viewer.assignmentFound || !isActive(viewer.assignment.active)) {
      return res.status(403).json({ error: "Active MPP assignment required" });
    }
    if (!MANAGER_ROLES.has(viewer.assignment.mpp_role)) {
      return res.status(403).json({ error: "Manager role required" });
    }
    if (!logId || !["verified", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "Valid logId and decision required" });
    }

    const log = await reviewShiftLog({
      locationId: viewer.activeLocation,
      logId: String(logId),
      reviewerUserId: viewer.userId,
      decision,
    });

    if (!log) {
      return res.status(409).json({ error: "Shift log is not pending or was not found" });
    }

    return res.json({ reviewed: true, log });
  } catch (error: any) {
    return sendSafeError(res, error, "review_shift_failed");
  }
});

/* P024: role-aware monthly rollup. */
app.post("/performance/rollup", async (req: Request, res: Response) => {
  try {
    const viewer: any = await resolveTrustedAssignment(req.body?.key);
    if (!viewer.assignmentFound || !isActive(viewer.assignment.active)) {
      return res.status(403).json({ error: "Active MPP assignment required" });
    }

    const month = /^\d{4}-\d{2}$/.test(String(req.body?.month ?? ""))
      ? String(req.body.month)
      : new Date().toISOString().slice(0, 7);
    const [year, monthNumber] = month.split("-").map(Number);
    const startDate = `${month}-01`;
    const nextMonth = new Date(Date.UTC(year, monthNumber, 1));
    const endDate = nextMonth.toISOString().slice(0, 10);

    const sellerUserId = viewer.assignment.mpp_role === "seller" ? viewer.userId : undefined;
    if (!sellerUserId && !MANAGER_ROLES.has(viewer.assignment.mpp_role)) {
      return res.status(403).json({ error: "Performance view not permitted" });
    }

    const rollup = await getPerformanceRollup({
      locationId: viewer.activeLocation,
      startDate,
      endDate,
      sellerUserId,
    });

    const opportunities = Number(rollup.totals?.opportunities ?? 0);
    const membershipsSold = Number(rollup.totals?.memberships_sold ?? 0);

    return res.json({
      month,
      scope: sellerUserId ? "self" : "location",
      totals: {
        ...rollup.totals,
        conversionRate: opportunities > 0 ? membershipsSold / opportunities : 0,
      },
      sellers: rollup.sellers.map((seller: any) => ({
        ...seller,
        conversionRate:
          Number(seller.opportunities) > 0
            ? Number(seller.memberships_sold) / Number(seller.opportunities)
            : 0,
      })),
    });
  } catch (error: any) {
    return sendSafeError(res, error, "performance_rollup_failed");
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path + "index.html");
});

async function start() {
  try {
    const hydratedCount = await ghl.initialize();
    const assignmentIndexCount = await initializeAssignmentIndex();
    await initializePerformanceStore();

    console.log("[P019A] OAuth store ready", { hydratedCount });
    console.log("[P019B] Assignment index ready", { assignmentIndexCount });
    console.log("[P020-P024] Product store ready");

    app.listen(port, () => {
      console.log(`GHL app listening on port ${port}`);
    });
  } catch (error: any) {
    console.error("[MPP] startup failed", {
      message: error?.message ?? "unknown",
    });
    process.exit(1);
  }
}

start();
