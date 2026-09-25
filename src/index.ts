import express, { Express, Response } from "express";
import dotenv from "dotenv";
import { createHash } from "node:crypto";
import { GHL } from "./ghl";
import { json } from "body-parser";
import {
  claimOAuthCallback,
  completeOAuthCallback,
  createShiftLog,
  failOAuthCallback,
  getAssignmentRecordId,
  getOAuthCallbackReceipt,
  getLocationGoal,
  getPerformanceRollup,
  getReviewQueue,
  getReviewFollowUps,
  getReportingTeamDestinations,
  getSellerGoal,
  getSellerGoalsForLocation,
  getSellerShiftLogs,
  getSellerShiftLog,
  getShiftLogForReview,
  getVerifiedPerformanceWindow,
  initializeAssignmentIndex,
  initializePerformanceStore,
  isValidReportingTeam,
  reconcileManagedTeam,
  reviewShiftLog,
  upsertAssignmentIndex,
  upsertLocationGoal,
  upsertSellerGoal,
} from "./db";
import {
  getLocationScopeGrants,
  hasLocationScopeGrant,
  initializeScopeGrantStore,
  upsertScopeGrant,
} from "./scope-grants";
import { initializeTrainingStore, registerTrainingRoutes } from "./training";

const path = __dirname + "/ui/dist/";
dotenv.config();
const app: Express = express();
app.use(json({ type: "application/json" }));
app.use(express.static(path));

const ghl = new GHL();
const port = process.env.PORT;
const SPOKE_COMPANY_ID = "NUAR0gljpx3i4RfDQPCf";
const LPR_OBJECT = "custom_objects.location_performance_reports";
const TEAM_OBJECT = "custom_objects.teams";
const ASSIGNMENT_OBJECT = "custom_objects.mpp_user_assignment";
const MANAGER_ROLES = new Set(["sales_manager", "general_manager", "regional_manager", "owner"]);
const PROVISION_ROLES = new Set(["general_manager", "regional_manager", "owner"]);
const LOCATION_GOAL_WRITE_ROLES = new Set(["general_manager", "regional_manager", "owner"]);
const SELLER_GOAL_WRITE_ROLES = new Set(["sales_manager"]);
const SELLER_GOAL_READ_ALL_ROLES = new Set(["sales_manager", "general_manager", "regional_manager", "owner"]);
const WEEKLY_REPORT_READ_ROLES = new Set(["sales_manager", "general_manager", "regional_manager", "owner"]);
const WEEKLY_REPORT_WRITE_ROLES = new Set(["general_manager"]);
const LOCATION_LABELS: Record<string,string> = {
  "e44pA2hEK8BXwer0eNYB": "MPP — Master Spoke Template",
  "aGn7Uf2qec6eTb9M6k1K": "MPP — TEST — Scope Spoke 02",
};

function isActive(value: unknown) { return String(value ?? "").trim().toLowerCase() === "yes"; }
function normalizeRole(value: unknown) { return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_"); }
function validMonth(value: any) { return /^\d{4}-\d{2}$/.test(String(value ?? "")); }
function validDate(value: any) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")); }
function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function monthBounds(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return { startDate: `${month}-01`, endDate: new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10) };
}
function pacing(month: string, target: number, actual: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const today = new Date();
  let elapsedDays = daysInMonth;
  if (today.getUTCFullYear() === year && today.getUTCMonth() + 1 === monthNumber) elapsedDays = Math.min(daysInMonth, today.getUTCDate());
  else if (Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1) < Date.UTC(year, monthNumber - 1, 1)) elapsedDays = 0;
  const expected = target * (elapsedDays / daysInMonth);
  return { daysInMonth, elapsedDays, expectedToDate: Number(expected.toFixed(2)), actual, variance: Number((actual - expected).toFixed(2)), percentOfGoal: target > 0 ? actual / target : 0 };
}
function moneyValue(value: any) {
  if (value && typeof value === "object") return Number(value.value ?? 0);
  return Number(value ?? 0);
}
function weeklyReportSource(record: any) {
  const source = String(record?.createdBy?.source ?? "").toUpperCase();
  const channel = String(record?.createdBy?.channel ?? "").toUpperCase();
  if (source === "INTEGRATION" || channel === "OAUTH") return "MPP";
  if (source === "FORM") return "Form";
  return "Other";
}
function scopeLocationMeta(locationId:string) {
  return { locationId, name: LOCATION_LABELS[locationId] ?? locationId };
}

async function ensureLocationToken(activeLocation: string) {
  if (ghl.checkInstallationExists(activeLocation)) return;
  const company = ghl.model.installationObjects[SPOKE_COMPANY_ID];
  if (!company || company.userType !== "Company") throw Object.assign(new Error("No OAuth token available for this location"), { statusCode: 403 });
  await ghl.getLocationTokenFromCompanyToken(SPOKE_COMPANY_ID, activeLocation);
  if (!ghl.checkInstallationExists(activeLocation)) throw Object.assign(new Error("Location token exchange produced no token"), { statusCode: 403 });
}

async function getObjectRecordById(locationId: string, objectKey: string, recordId: string) {
  const response = await ghl.requests(locationId).get(`/objects/${objectKey}/records/${recordId}`, { headers: { Version: "v3" } });
  return response.data?.record ?? null;
}

async function getRecordById(locationId: string, recordId: string) {
  return getObjectRecordById(locationId, ASSIGNMENT_OBJECT, recordId);
}

async function searchObjectRecords(locationId:string,objectKey:string) {
  const response=await ghl.requests(locationId).post(`/objects/${objectKey}/records/search`,{
    locationId,page:1,pageLimit:100,
  },{headers:{Version:"v3"}});
  return response.data?.records ?? [];
}

async function findWeeklyReport(locationId: string, weekStart: string) {
  const response = await ghl.requests(locationId).post(`/objects/${LPR_OBJECT}/records/search`, {
    locationId,
    page: 1,
    pageLimit: 20,
  }, { headers: { Version: "v3" } });
  const records = response.data?.records ?? [];
  return records.find((record: any) =>
    String(record.properties?.report_label ?? "").slice(0, 10) === weekStart ||
    String(record.properties?.week_start ?? "").slice(0, 10) === weekStart
  ) ?? null;
}

function serializeWeeklyReport(record: any) {
  if (!record) return null;
  const p = record.properties ?? {};
  return {
    recordId: record.id,
    reportLabel: p.report_label ?? null,
    weekStart: String(p.week_start ?? "").slice(0, 10),
    weekEnd: String(p.week_end ?? "").slice(0, 10),
    totalRetailWashesSold: Number(p.total_retail_washes_sold ?? 0),
    retailRevenue: moneyValue(p.retail_revenue),
    totalMembershipsSold: Number(p.total_memberships_sold ?? 0),
    membershipRevenue: moneyValue(p.membership_revenue),
    membershipCancellations: Number(p.membership_cancellations ?? 0),
    notes: String(p.notes ?? ""),
  };
}

function decryptTrustedIdentity(key: string) {
  if (!key) throw Object.assign(new Error("SSO key required"), { statusCode: 400 });
  let ssoData: any;
  try { ssoData = ghl.decryptSSOData(key); } catch { throw Object.assign(new Error("Invalid SSO key"), { statusCode: 401 }); }
  const { userId, activeLocation } = ssoData;
  if (!userId || !activeLocation) throw Object.assign(new Error("SSO data missing required identity fields"), { statusCode: 401 });
  return { ssoData, userId, activeLocation };
}

async function resolveTrustedAssignment(key: string) {
  const identity = decryptTrustedIdentity(key);
  await ensureLocationToken(identity.activeLocation);
  const recordId = await getAssignmentRecordId(identity.activeLocation, identity.userId);
  if (!recordId) return { ...identity, assignmentFound: false };
  const record = await getRecordById(identity.activeLocation, recordId);
  if (!record || record.properties?.ghl_user_id !== identity.userId) return { ...identity, assignmentFound: false };
  return { ...identity, assignmentFound: true, assignment: {
    recordId,
    mpp_role: normalizeRole(record.properties?.mpp_role),
    scope_type: String(record.properties?.scope_type ?? "").trim().toLowerCase(),
    active: record.properties?.active ?? null,
    assignment_name: record.properties?.assignment_name ?? null,
    ghl_user_id: record.properties?.ghl_user_id ?? null,
    managed_team_id: String(record.properties?.managed_team_id ?? "").trim() || null,
  }};
}

async function resolveManagedTeam(viewer:any) {
  if (!viewer.assignmentFound || !isActive(viewer.assignment.active) ||
      viewer.assignment.mpp_role !== "sales_manager") {
    throw Object.assign(new Error("Active Sales Manager assignment required"),{statusCode:403});
  }
  const managedTeamId=String(viewer.assignment.managed_team_id??"").trim();
  if (!managedTeamId) throw Object.assign(new Error("Managed Team assignment is required"),{statusCode:403});
  const team=await getObjectRecordById(viewer.activeLocation,TEAM_OBJECT,managedTeamId);
  if (!team || !isActive(team.properties?.active)) {
    throw Object.assign(new Error("Managed Team is unavailable or inactive"),{statusCode:403});
  }
  const assignments=await searchObjectRecords(viewer.activeLocation,ASSIGNMENT_OBJECT);
  const conflicts=assignments.filter((record:any)=>
    record.id!==viewer.assignment.recordId &&
    normalizeRole(record.properties?.mpp_role)==="sales_manager" &&
    isActive(record.properties?.active) &&
    String(record.properties?.managed_team_id??"").trim()===managedTeamId
  );
  if (conflicts.length) throw Object.assign(new Error("Managed Team has conflicting active manager assignments"),{statusCode:403});
  await reconcileManagedTeam({locationId:viewer.activeLocation,smUserId:viewer.userId,
    teamRecordId:managedTeamId,assignmentRecordId:viewer.assignment.recordId});
  return {teamRecordId:managedTeamId,teamName:String(team.properties?.team_name??"Team")};
}

async function resolveAuthorizedLocation(viewer: any, requestedLocationId?: unknown) {
  if (!viewer.assignmentFound || !isActive(viewer.assignment.active)) throw Object.assign(new Error("Active MPP assignment required"), { statusCode: 403 });
  const requested = String(requestedLocationId ?? viewer.activeLocation ?? "").trim();
  if (!requested) throw Object.assign(new Error("Location scope required"), { statusCode: 400 });
  const granted = await hasLocationScopeGrant(viewer.userId, requested);
  if (!granted) throw Object.assign(new Error("Requested location is outside your MPP scope"), { statusCode: 403 });
  await ensureLocationToken(requested);
  return requested;
}

function sendSafeError(res: Response, error: any, fallback = "request_failed") {
  const status = error?.statusCode ?? 500;
  console.error("[MPP] request error", { status, message: error?.message ?? "unknown" });
  return res.status(status).json({ error: error?.message ?? fallback });
}

async function buildWeeklyWorkspace(viewer: any, weekStart: string) {
  const weekEnd = addDays(weekStart, 6);
  const endExclusive = addDays(weekStart, 7);
  const verified = await getVerifiedPerformanceWindow(viewer.activeLocation, weekStart, endExclusive);
  const opportunities = Number(verified.totals?.opportunities ?? 0);
  const membershipsSold = Number(verified.totals?.memberships_sold ?? 0);
  const month = weekStart.slice(0, 7);
  const sellerGoals = await getSellerGoalsForLocation(viewer.activeLocation, month);
  const goalsBySeller = new Map(sellerGoals.map((goal: any) => [goal.seller_user_id, Number(goal.conversion_target)]));
  const sellers = verified.sellers.map((seller: any) => {
    const conversionRate = Number(seller.opportunities) > 0 ? Number(seller.memberships_sold) / Number(seller.opportunities) : 0;
    const conversionGoal = goalsBySeller.has(seller.seller_user_id) ? goalsBySeller.get(seller.seller_user_id) : null;
    return { ...seller, conversionRate, conversionGoal, conversionVariance: conversionGoal === null ? null : conversionRate - Number(conversionGoal) };
  });
  const locationGoal = await getLocationGoal(viewer.activeLocation, month);
  const bounds = monthBounds(month);
  const monthPerf = await getPerformanceRollup({ locationId: viewer.activeLocation, startDate: bounds.startDate, endDate: bounds.endDate });
  const monthActual = Number(monthPerf.totals?.memberships_sold ?? 0);
  const existingRecord = await findWeeklyReport(viewer.activeLocation, weekStart);
  const report = serializeWeeklyReport(existingRecord);
  const difference = report ? report.totalMembershipsSold - membershipsSold : null;
  return {
    selectedScopeLocation: viewer.activeLocation,
    weekStart,
    weekEnd,
    derived: { opportunities, membershipsSold, conversionRate: opportunities > 0 ? membershipsSold / opportunities : 0, sellers },
    locationGoal: locationGoal ? { goal: locationGoal, pace: pacing(month, Number(locationGoal.memberships_target), monthActual) } : null,
    report,
    reconciliation: report ? { mppSold: membershipsSold, reportedSold: report.totalMembershipsSold, difference, matches: difference === 0 } : null,
  };
}


async function verifyBoundedObjectRead(locationId: string) {
  const response = await ghl.requests(locationId).post(
    "/objects/custom_objects.mpp_user_assignment/records/search",
    { locationId, page: 1, pageLimit: 1 },
    { headers: { Version: "v3" } }
  );
  return {
    http_status: response.status,
    locationId,
    total: Number(response.data?.total ?? 0),
    record_count: Array.isArray(response.data?.records) ? response.data.records.length : 0,
  };
}

async function waitForOAuthReceipt(codeHash: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const receipt = await getOAuthCallbackReceipt(codeHash);
    if (!receipt || receipt.status !== "pending") return receipt;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return getOAuthCallbackReceipt(codeHash);
}

async function recoverCompletedOAuthReceipt(codeHash: string) {
  const targetLocationId = String(process.env.GHL_BOOTSTRAP_LOCATION_ID ?? "").trim();
  if (!targetLocationId) return false;
  try {
    const proof = await bootstrapConfiguredLocation();
    if (!proof) return false;
    const company = Object.entries(ghl.model.installationObjects)
      .find(([, installation]) => installation.userType === "Company");
    await completeOAuthCallback(codeHash, company?.[0] ?? null, targetLocationId);
    console.log("[V1A-00-oauth] recovered completed installation", {
      companyId: company?.[0] ?? null,
      locationId: targetLocationId,
      read_http_status: proof.http_status,
      read_total: proof.total,
    });
    return true;
  } catch (error: any) {
    console.error("[V1A-00-oauth] recovery pending", {
      status: error?.response?.status ?? null,
      message: error?.message ?? "unknown",
      locationId: targetLocationId,
    });
    return false;
  }
}

async function bootstrapConfiguredLocation() {
  const targetLocationId = String(process.env.GHL_BOOTSTRAP_LOCATION_ID ?? "").trim();
  if (!targetLocationId) return null;
  if (!ghl.checkInstallationExists(targetLocationId)) {
    const company = Object.entries(ghl.model.installationObjects)
      .find(([, installation]) => installation.userType === "Company");
    if (!company) {
      console.log("[V1A-00-bootstrap] awaiting Company grant", { locationId: targetLocationId });
      return null;
    }
    await ghl.getLocationTokenFromCompanyToken(company[0], targetLocationId);
  }
  const proof = await verifyBoundedObjectRead(targetLocationId);
  console.log("[V1A-00-read-proof]", proof);
  return proof;
}

registerTrainingRoutes(app, { resolveTrustedAssignment, isActive, managerRoles: MANAGER_ROLES });

app.get("/authorize-handler", async (req, res) => { await ghl.authorizationHandler(req.query.code as string); res.redirect("https://app.gohighlevel.com/"); });
app.post("/decrypt-sso", async (req, res) => { try { return res.send(ghl.decryptSSOData(req.body?.key)); } catch { return res.status(400).send("Invalid Key"); } });
app.get("/oauth/callback", async (req, res) => {
  const code = String(req.query.code ?? "");
  if (!code) return res.status(200).send("MPP OAuth Callback Received");
  const codeHash = createHash("sha256").update(code).digest("hex");
  const claim = await claimOAuthCallback(codeHash);

  if (!claim.claimed) {
    if (claim.status === "complete") return res.status(200).send("MPP OAuth Installation Already Complete");
    if (claim.status === "failed") {
      if (await recoverCompletedOAuthReceipt(codeHash)) {
        return res.status(200).send("MPP OAuth Installation Already Complete");
      }
      return res.status(500).send("MPP OAuth Installation Previously Failed");
    }
    const receipt = await waitForOAuthReceipt(codeHash);
    if (receipt?.status === "complete") return res.status(200).send("MPP OAuth Installation Already Complete");
    if (receipt?.status === "failed") {
      if (await recoverCompletedOAuthReceipt(codeHash)) {
        return res.status(200).send("MPP OAuth Installation Already Complete");
      }
      return res.status(500).send("MPP OAuth Installation Previously Failed");
    }
    return res.status(202).send("MPP OAuth Installation Processing");
  }

  try {
    const installation: any = await ghl.authorizationHandler(code);
    const targetLocationId = String(process.env.GHL_BOOTSTRAP_LOCATION_ID ?? "").trim();
    let locationId = installation.locationId ?? null;
    const companyId = installation.companyId ?? null;

    if (installation.userType === "Company") {
      if (!companyId || !targetLocationId) throw new Error("Company grant requires configured bootstrap Location");
      await ghl.getLocationTokenFromCompanyToken(companyId, targetLocationId);
      locationId = targetLocationId;
    }
    if (targetLocationId && locationId !== targetLocationId) {
      throw new Error("OAuth installation resolved an unexpected Location");
    }

    const proof = await verifyBoundedObjectRead(locationId);
    await completeOAuthCallback(codeHash, companyId, locationId);
    console.log("[V1A-00-oauth] installation complete", {
      companyId,
      locationId,
      userType: installation.userType ?? null,
      read_http_status: proof.http_status,
      read_total: proof.total,
    });
    return res.status(200).send("MPP OAuth Installation Complete");
  } catch (error: any) {
    await failOAuthCallback(codeHash, "oauth_bootstrap_failed");
    console.error("[MPP] OAuth callback failed", {
      status: error?.response?.status ?? null,
      message: error?.message ?? "unknown",
    });
    return res.status(500).send("MPP OAuth token exchange/storage failed");
  }
});
app.get("/oauth/token-status", (_req, res) => { const locationId = "e44pA2hEK8BXwer0eNYB"; const inst = ghl.model.installationObjects[locationId]; const keys = Object.keys(ghl.model.installationObjects); res.json({ tokenAvailable: ghl.checkInstallationExists(locationId), locationId: inst?.locationId ?? null, companyId: inst?.companyId ?? null, userType: inst?.userType ?? null, expires_in: inst?.expires_in ?? null, refreshTokenPresent: !!ghl.model.getRefreshToken(locationId), installationObjectsKeys: keys, storedKey: keys[0] ?? null }); });

app.post("/assignment-context", async (req, res) => {
  try {
    const viewer: any = await resolveTrustedAssignment(req.body?.key);
    console.log("[V1A-assignment-context]", { userId: viewer.userId, activeLocation: viewer.activeLocation, assignmentFound: viewer.assignmentFound });
    if (!viewer.assignmentFound) return res.json({ trustedUserId: viewer.userId, activeLocation: viewer.activeLocation, tokenVerified: true, assignmentFound: false, assignment: null, capabilities: [], scopeLocations: [] });
    const role = viewer.assignment.mpp_role;
    const active = isActive(viewer.assignment.active);
    const capabilities = active ? ["view_shell", ...(role === "seller" ? ["submit_shift", "view_self"] : []), ...(MANAGER_ROLES.has(role) ? ["view_location", "review_logs"] : []), ...(PROVISION_ROLES.has(role) ? ["provision_assignments"] : []), ...(LOCATION_GOAL_WRITE_ROLES.has(role) ? ["manage_location_goal"] : []), ...(SELLER_GOAL_WRITE_ROLES.has(role) ? ["manage_seller_goals"] : []), ...(WEEKLY_REPORT_READ_ROLES.has(role) ? ["view_weekly_report"] : []), ...(WEEKLY_REPORT_WRITE_ROLES.has(role) ? ["manage_weekly_report"] : [])] : [];
    const scopeLocations = active ? (await getLocationScopeGrants(viewer.userId)).map((grant:any) => scopeLocationMeta(grant.scope_id)) : [];
    return res.json({ trustedUserId: viewer.userId, activeLocation: viewer.activeLocation, tokenVerified: true, assignmentFound: true, assignment: viewer.assignment, capabilities, scopeLocations });
  } catch (error: any) { return sendSafeError(res, error, "assignment_lookup_failed"); }
});

app.post("/admin/assignment-provision", async (req, res) => {
  try {
    const { key, recordId } = req.body || {};
    if (!recordId || typeof recordId !== "string") return res.status(400).json({ error: "recordId required" });
    const identity = decryptTrustedIdentity(key); await ensureLocationToken(identity.activeLocation);
    const targetRecord = await getRecordById(identity.activeLocation, recordId); const targetUserId = targetRecord?.properties?.ghl_user_id;
    if (!targetRecord || !targetUserId) return res.status(400).json({ error: "Target assignment record is invalid" });
    if (!isActive(targetRecord.properties?.active)) return res.status(400).json({ error: "Target assignment record is inactive" });
    const existing = await getAssignmentRecordId(identity.activeLocation, identity.userId); let mode: "self" | "admin" = "self";
    if (!existing) { if (targetUserId !== identity.userId) return res.status(403).json({ error: "Self-provisioning requires your own assignment record" }); }
    else { const caller: any = await resolveTrustedAssignment(key); if (!caller.assignmentFound || !isActive(caller.assignment.active)) return res.status(403).json({ error: "Active MPP assignment required" }); if (!PROVISION_ROLES.has(caller.assignment.mpp_role)) return res.status(403).json({ error: "Assignment provisioning not permitted" }); mode = "admin"; }
    await upsertAssignmentIndex(identity.activeLocation, targetUserId, recordId);
    await upsertScopeGrant({ ghlUserId: targetUserId, assignmentRecordId: recordId, scopeId: identity.activeLocation });
    return res.json({ provisioned: true, mode, locationId: identity.activeLocation, recordId, assignment: { assignment_name: targetRecord.properties?.assignment_name ?? null, ghl_user_id: targetUserId, mpp_role: normalizeRole(targetRecord.properties?.mpp_role), scope_type: targetRecord.properties?.scope_type ?? null, active: targetRecord.properties?.active ?? null } });
  } catch (error: any) { return sendSafeError(res, error, "assignment_provision_failed"); }
});

app.post("/admin/scope-grant", async (req, res) => {
  try {
    const viewer:any = await resolveTrustedAssignment(req.body?.key);
    if (!viewer.assignmentFound || !isActive(viewer.assignment.active) || !PROVISION_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Scope grant management not permitted" });
    const recordId = String(req.body?.recordId ?? "").trim();
    const scopeId = String(req.body?.scopeId ?? "").trim();
    if (!recordId || !scopeId) return res.status(400).json({ error: "recordId and scopeId required" });
    const targetRecord = await getRecordById(viewer.activeLocation, recordId);
    const targetUserId = String(targetRecord?.properties?.ghl_user_id ?? "").trim();
    if (!targetRecord || !targetUserId || !isActive(targetRecord.properties?.active)) return res.status(400).json({ error: "Target assignment must be active in the host location" });
    await ensureLocationToken(scopeId);
    const grant = await upsertScopeGrant({ ghlUserId: targetUserId, assignmentRecordId: recordId, scopeId });
    return res.json({ granted: true, grant });
  } catch (error:any) { return sendSafeError(res,error,"scope_grant_failed"); }
});

app.post("/seller/reporting-teams", async (req,res) => {
  try {
    const viewer:any=await resolveTrustedAssignment(req.body?.key);
    if (!viewer.assignmentFound||!isActive(viewer.assignment.active)||
        !["seller","sales_manager","general_manager"].includes(viewer.assignment.mpp_role)) {
      return res.status(403).json({error:"Seller activity is not permitted"});
    }
    const teams=await getReportingTeamDestinations(viewer.activeLocation,viewer.userId);
    console.log("[V1A-reporting-teams]", { userId: viewer.userId, activeLocation: viewer.activeLocation, teamCount: teams.length });
    return res.json({teams:teams.map((team:any)=>({teamId:team.team_record_id,teamName:team.team_name}))});
  } catch(error:any) { return sendSafeError(res,error); }
});

app.post("/seller/shift-log", async (req, res) => {
  try {
    const viewer:any=await resolveTrustedAssignment(req.body?.key);
    if (!viewer.assignmentFound||!isActive(viewer.assignment.active)||
        !["seller","sales_manager","general_manager"].includes(viewer.assignment.mpp_role)) {
      return res.status(403).json({error:"Seller activity is not permitted"});
    }
    const opportunities=Number(req.body?.opportunities);
    const membershipsSold=Number(req.body?.membershipsSold);
    const shiftDate=String(req.body?.shiftDate??"");
    const teamRecordId=String(req.body?.reportToTeamId??"").trim();
    if (!validDate(shiftDate)||!Number.isInteger(opportunities)||opportunities<0||
        !Number.isInteger(membershipsSold)||membershipsSold<0||membershipsSold>opportunities||
        !teamRecordId) return res.status(400).json({error:"Invalid shift values or Report to Team"});
    const team=await isValidReportingTeam(viewer.activeLocation,viewer.userId,teamRecordId);
    if (!team) return res.status(403).json({error:"Report to Team destination is not authorized"});
    const log=await createShiftLog({locationId:viewer.activeLocation,sellerUserId:viewer.userId,
      sellerName:viewer.assignment.assignment_name||viewer.ssoData.userName||"Seller",
      assignmentRecordId:viewer.assignment.recordId,teamRecordId,teamName:team.team_name,
      shiftDate,opportunities,membershipsSold,notes:String(req.body?.notes??"").slice(0,2000)});
    return res.status(201).json({created:true,log});
  } catch(error:any) { return sendSafeError(res,error); }
});

app.post("/seller/shift-logs", async (req,res) => {
  try {
    const viewer:any=await resolveTrustedAssignment(req.body?.key);
    if (!viewer.assignmentFound||!isActive(viewer.assignment.active)) return res.status(403).json({error:"Active MPP assignment required"});
    return res.json({logs:await getSellerShiftLogs(viewer.activeLocation,viewer.userId,30)});
  } catch(error:any) { return sendSafeError(res,error); }
});

app.post("/seller/shift-log-detail", async (req,res) => {
  try {
    const viewer:any=await resolveTrustedAssignment(req.body?.key);
    if (!viewer.assignmentFound||!isActive(viewer.assignment.active)) return res.status(403).json({error:"Active MPP assignment required"});
    const log=await getSellerShiftLog(viewer.activeLocation,viewer.userId,String(req.body?.logId??""));
    return log?res.json({log}):res.status(404).json({error:"Activity Report not found"});
  } catch(error:any) { return sendSafeError(res,error); }
});

app.post("/manager/review-queue", async (req,res) => {
  try {
    const viewer:any=await resolveTrustedAssignment(req.body?.key);
    const managed=await resolveManagedTeam(viewer);
    return res.json({selectedScopeLocation:viewer.activeLocation,managedTeam:managed,
      logs:await getReviewQueue(viewer.activeLocation,managed.teamRecordId)});
  } catch(error:any) { return sendSafeError(res,error); }
});

app.post("/manager/review-follow-ups", async (req,res) => {
  try {
    const viewer:any=await resolveTrustedAssignment(req.body?.key);
    const managed=await resolveManagedTeam(viewer);
    return res.json({selectedScopeLocation:viewer.activeLocation,managedTeam:managed,
      logs:await getReviewFollowUps(viewer.activeLocation,managed.teamRecordId)});
  } catch(error:any) { return sendSafeError(res,error); }
});

app.post("/manager/review-shift-detail", async (req,res) => {
  try {
    const viewer:any=await resolveTrustedAssignment(req.body?.key);
    const managed=await resolveManagedTeam(viewer);
    const log=await getShiftLogForReview(viewer.activeLocation,managed.teamRecordId,String(req.body?.logId??""));
    return log?res.json({managedTeam:managed,log}):res.status(404).json({error:"Activity Report not found"});
  } catch(error:any) { return sendSafeError(res,error); }
});

app.post("/manager/review-shift", async (req,res) => {
  try {
    const viewer:any=await resolveTrustedAssignment(req.body?.key);
    const managed=await resolveManagedTeam(viewer);
    const decision=String(req.body?.decision??"");
    const actionId=String(req.body?.reviewActionId??"").trim();
    const expectedVersion=Number(req.body?.expectedReviewVersion);
    if (!req.body?.logId||!["Verified","Needs Review"].includes(decision)||!actionId||
        !Number.isInteger(expectedVersion)||expectedVersion<0) {
      return res.status(400).json({error:"Complete review action context is required"});
    }
    const result=await reviewShiftLog({locationId:viewer.activeLocation,managedTeamId:managed.teamRecordId,
      logId:String(req.body.logId),reviewerUserId:viewer.userId,
      reviewerName:viewer.assignment.assignment_name||viewer.ssoData.userName||"Manager",
      decision,managerNote:String(req.body?.managerNote??"").slice(0,2000),
      expectedVersion,actionId,correlationId:actionId});
    if (!result) return res.status(404).json({error:"Activity Report not found"});
    console.log("[V1A-review]",{reportId:String(req.body.logId),actionId,
      status:result.log.review_status,version:result.log.review_version,idempotent:result.idempotent});
    return res.json({reviewed:true,...result});
  } catch(error:any) { return sendSafeError(res,error); }
});

app.post("/performance/rollup", async (req, res) => {
  try {
    const viewer: any = await resolveTrustedAssignment(req.body?.key); if (!viewer.assignmentFound || !isActive(viewer.assignment.active)) return res.status(403).json({ error: "Active MPP assignment required" });
    const selectedLocation = await resolveAuthorizedLocation(viewer, req.body?.selectedScopeLocation);
    const month = validMonth(req.body?.month) ? String(req.body.month) : new Date().toISOString().slice(0, 7); const { startDate, endDate } = monthBounds(month); const sellerUserId = viewer.assignment.mpp_role === "seller" ? viewer.userId : undefined;
    if (!sellerUserId && !MANAGER_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Performance view not permitted" });
    const rollup = await getPerformanceRollup({ locationId: selectedLocation, startDate, endDate, sellerUserId });
    const goals = sellerUserId ? [await getSellerGoal(selectedLocation, sellerUserId, month)].filter(Boolean) : await getSellerGoalsForLocation(selectedLocation, month);
    const goalsBySeller = new Map(goals.map((goal: any) => [goal.seller_user_id, Number(goal.conversion_target)])); const opportunities = Number(rollup.totals?.opportunities ?? 0), membershipsSold = Number(rollup.totals?.memberships_sold ?? 0);
    const sellers = rollup.sellers.map((seller: any) => { const conversionRate = Number(seller.opportunities) > 0 ? Number(seller.memberships_sold) / Number(seller.opportunities) : 0; const conversionGoal = goalsBySeller.has(seller.seller_user_id) ? goalsBySeller.get(seller.seller_user_id) : null; return { ...seller, conversionRate, conversionGoal, conversionVariance: conversionGoal === null ? null : conversionRate - Number(conversionGoal) }; });
    const selfGoal = sellerUserId && goals.length ? Number((goals[0] as any).conversion_target) : null, selfActual = opportunities > 0 ? membershipsSold / opportunities : 0;
    return res.json({ selectedScopeLocation: selectedLocation, month, scope: sellerUserId ? "self" : "location", totals: { ...rollup.totals, conversionRate: selfActual }, sellers, sellerGoal: sellerUserId ? { conversionGoal: selfGoal, conversionVariance: selfGoal === null ? null : selfActual - selfGoal } : null });
  } catch (error: any) { return sendSafeError(res, error); }
});

app.post("/goals/location", async (req, res) => { try { const viewer: any = await resolveTrustedAssignment(req.body?.key); if (!viewer.assignmentFound || !isActive(viewer.assignment.active)) return res.status(403).json({ error: "Active MPP assignment required" }); const selectedLocation = await resolveAuthorizedLocation(viewer, req.body?.selectedScopeLocation); const month = validMonth(req.body?.month) ? String(req.body.month) : new Date().toISOString().slice(0, 7); const goal = await getLocationGoal(selectedLocation, month); const { startDate, endDate } = monthBounds(month); const performance = await getPerformanceRollup({ locationId: selectedLocation, startDate, endDate }); const actual = Number(performance.totals?.memberships_sold ?? 0); return res.json({ selectedScopeLocation: selectedLocation, month, goal, pace: goal ? pacing(month, Number(goal.memberships_target), actual) : null }); } catch (error: any) { return sendSafeError(res, error, "location_goal_failed"); } });
app.post("/goals/location/set", async (req, res) => { try { const viewer: any = await resolveTrustedAssignment(req.body?.key); if (!viewer.assignmentFound || !isActive(viewer.assignment.active) || !LOCATION_GOAL_WRITE_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Location goal management not permitted" }); const month = String(req.body?.month ?? ""), membershipsTarget = Number(req.body?.membershipsTarget), conversionTarget = Number(req.body?.conversionTarget); if (!validMonth(month) || !Number.isInteger(membershipsTarget) || membershipsTarget < 0 || !Number.isFinite(conversionTarget) || conversionTarget < 0 || conversionTarget > 1) return res.status(400).json({ error: "Valid month, memberships target, and conversion target required" }); const goal = await upsertLocationGoal({ locationId: viewer.activeLocation, month, membershipsTarget, conversionTarget, setByUserId: viewer.userId }); return res.json({ saved: true, goal }); } catch (error: any) { return sendSafeError(res, error, "location_goal_save_failed"); } });
app.post("/goals/seller/set", async (req, res) => { try { const viewer: any = await resolveTrustedAssignment(req.body?.key); if (!viewer.assignmentFound || !isActive(viewer.assignment.active) || !SELLER_GOAL_WRITE_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Seller goal management not permitted" }); const sellerUserId = String(req.body?.sellerUserId ?? ""), month = String(req.body?.month ?? ""), conversionTarget = Number(req.body?.conversionTarget); if (!sellerUserId || !validMonth(month) || !Number.isFinite(conversionTarget) || conversionTarget < 0 || conversionTarget > 1) return res.status(400).json({ error: "Valid seller, month, and conversion target required" }); const targetRecordId = await getAssignmentRecordId(viewer.activeLocation, sellerUserId); if (!targetRecordId) return res.status(400).json({ error: "Seller assignment is not indexed for this location" }); const targetRecord = await getRecordById(viewer.activeLocation, targetRecordId); if (!targetRecord || targetRecord.properties?.ghl_user_id !== sellerUserId || normalizeRole(targetRecord.properties?.mpp_role) !== "seller" || !isActive(targetRecord.properties?.active)) return res.status(400).json({ error: "Target must be an active Seller assignment in this location" }); const goal = await upsertSellerGoal({ locationId: viewer.activeLocation, sellerUserId, month, conversionTarget, setByUserId: viewer.userId }); return res.json({ saved: true, goal: { seller_user_id: goal.seller_user_id, goal_month: goal.goal_month, conversion_target: goal.conversion_target } }); } catch (error: any) { return sendSafeError(res, error, "seller_goal_save_failed"); } });
app.post("/goals/seller", async (req, res) => { try { const viewer: any = await resolveTrustedAssignment(req.body?.key); if (!viewer.assignmentFound || !isActive(viewer.assignment.active)) return res.status(403).json({ error: "Active MPP assignment required" }); const month = validMonth(req.body?.month) ? String(req.body.month) : new Date().toISOString().slice(0, 7); if (viewer.assignment.mpp_role === "seller") { const goal = await getSellerGoal(viewer.activeLocation, viewer.userId, month); return res.json({ month, goals: goal ? [goal] : [] }); } if (!SELLER_GOAL_READ_ALL_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Seller goal view not permitted" }); const requestedSeller = String(req.body?.sellerUserId ?? "").trim(); if (requestedSeller) { const goal = await getSellerGoal(viewer.activeLocation, requestedSeller, month); return res.json({ month, goals: goal ? [goal] : [] }); } return res.json({ month, goals: await getSellerGoalsForLocation(viewer.activeLocation, month) }); } catch (error: any) { return sendSafeError(res, error, "seller_goal_failed"); } });

app.post("/reports/weekly", async (req, res) => {
  try {
    const viewer: any = await resolveTrustedAssignment(req.body?.key);
    if (!viewer.assignmentFound || !isActive(viewer.assignment.active) || !WEEKLY_REPORT_READ_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Weekly report access requires manager role" });
    const selectedLocation = await resolveAuthorizedLocation(viewer, req.body?.selectedScopeLocation);
    const scopedViewer = { ...viewer, activeLocation: selectedLocation, hostLocation: viewer.activeLocation };
    const weekStart = String(req.body?.weekStart ?? ""); if (!validDate(weekStart)) return res.status(400).json({ error: "Valid weekStart required" });
    return res.json(await buildWeeklyWorkspace(scopedViewer, weekStart));
  } catch (error: any) { return sendSafeError(res, error, "weekly_report_failed"); }
});

app.post("/reports/history", async (req, res) => {
  try {
    const viewer: any = await resolveTrustedAssignment(req.body?.key);
    if (!viewer.assignmentFound || !isActive(viewer.assignment.active) || !WEEKLY_REPORT_READ_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Report history requires manager role" });
    const selectedLocation = await resolveAuthorizedLocation(viewer, req.body?.selectedScopeLocation);
    const response = await ghl.requests(selectedLocation).post(`/objects/${LPR_OBJECT}/records/search`, {
      locationId: selectedLocation,
      page: 1,
      pageLimit: 20,
      sort: [{ field: "properties.week_start", direction: "desc" }],
    }, { headers: { Version: "v3" } });
    const records = response.data?.records ?? [];
    const reports = await Promise.all(records.map(async (record: any) => {
      const p = record.properties ?? {};
      const weekStart = String(p.week_start ?? p.report_label ?? "").slice(0, 10);
      const weekEnd = String(p.week_end ?? "").slice(0, 10) || (validDate(weekStart) ? addDays(weekStart, 6) : "");
      const reportedSold = Number(p.total_memberships_sold ?? 0);
      let mppSold = 0;
      let difference: number | null = null;
      let status: "matched" | "mismatch" | "saved" = "saved";
      if (validDate(weekStart)) {
        const verified = await getVerifiedPerformanceWindow(selectedLocation, weekStart, addDays(weekStart, 7));
        const opportunities = Number(verified.totals?.opportunities ?? 0);
        mppSold = Number(verified.totals?.memberships_sold ?? 0);
        if (opportunities > 0 || mppSold > 0) {
          difference = reportedSold - mppSold;
          status = difference === 0 ? "matched" : "mismatch";
        }
      }
      return {
        recordId: record.id,
        reportLabel: p.report_label ?? null,
        weekStart,
        weekEnd,
        reportedSold,
        mppSold,
        difference,
        status,
        totalRetailWashesSold: Number(p.total_retail_washes_sold ?? 0),
        retailRevenue: moneyValue(p.retail_revenue),
        membershipRevenue: moneyValue(p.membership_revenue),
        membershipCancellations: Number(p.membership_cancellations ?? 0),
        notes: String(p.notes ?? ""),
        source: weeklyReportSource(record),
        createdAt: record.createdAt ?? null,
        updatedAt: record.updatedAt ?? null,
      };
    }));
    return res.json({ selectedScopeLocation: selectedLocation, total: Number(response.data?.total ?? reports.length), reports });
  } catch (error: any) { return sendSafeError(res, error, "report_history_failed"); }
});

app.post("/reports/weekly/save", async (req, res) => {
  try {
    const viewer: any = await resolveTrustedAssignment(req.body?.key);
    if (!viewer.assignmentFound || !isActive(viewer.assignment.active) || !WEEKLY_REPORT_WRITE_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Weekly report management requires General Manager role" });
    const weekStart = String(req.body?.weekStart ?? ""); if (!validDate(weekStart)) return res.status(400).json({ error: "Valid weekStart required" });
    const fields = {
      totalRetailWashesSold: Number(req.body?.totalRetailWashesSold),
      retailRevenue: Number(req.body?.retailRevenue),
      totalMembershipsSold: Number(req.body?.totalMembershipsSold),
      membershipRevenue: Number(req.body?.membershipRevenue),
      membershipCancellations: Number(req.body?.membershipCancellations),
    };
    if (!Number.isInteger(fields.totalRetailWashesSold) || fields.totalRetailWashesSold < 0 || !Number.isFinite(fields.retailRevenue) || fields.retailRevenue < 0 || !Number.isInteger(fields.totalMembershipsSold) || fields.totalMembershipsSold < 0 || !Number.isFinite(fields.membershipRevenue) || fields.membershipRevenue < 0 || !Number.isInteger(fields.membershipCancellations) || fields.membershipCancellations < 0) return res.status(400).json({ error: "Weekly report values must be non-negative numbers" });
    const weekEnd = addDays(weekStart, 6);
    const properties = {
      report_label: weekStart,
      week_start: weekStart,
      week_end: weekEnd,
      total_retail_washes_sold: fields.totalRetailWashesSold,
      retail_revenue: { value: fields.retailRevenue, currency: "default" },
      total_memberships_sold: fields.totalMembershipsSold,
      membership_revenue: { value: fields.membershipRevenue, currency: "default" },
      membership_cancellations: fields.membershipCancellations,
      notes: String(req.body?.notes ?? "").slice(0, 4000),
    };
    const existing = await findWeeklyReport(viewer.activeLocation, weekStart);
    if (existing?.id) {
      await ghl.requests(viewer.activeLocation).put(`/objects/${LPR_OBJECT}/records/${existing.id}?locationId=${encodeURIComponent(viewer.activeLocation)}`, { properties }, { headers: { Version: "v3" } });
    } else {
      await ghl.requests(viewer.activeLocation).post(`/objects/${LPR_OBJECT}/records`, { locationId: viewer.activeLocation, properties }, { headers: { Version: "v3" } });
    }
    return res.json({ saved: true, workspace: await buildWeeklyWorkspace(viewer, weekStart) });
  } catch (error: any) { return sendSafeError(res, error, "weekly_report_save_failed"); }
});

app.get("/", (_req, res) => res.sendFile(path + "index.html"));
async function start() {
  try {
    const hydratedCount = await ghl.initialize();
    try {
      await bootstrapConfiguredLocation();
    } catch (error: any) {
      console.error("[V1A-00-bootstrap] deferred", {
        status: error?.response?.status ?? null,
        message: error?.message ?? "unknown",
      });
    }
    const assignmentIndexCount = await initializeAssignmentIndex();
    await initializePerformanceStore();
    const scopeGrantCount = await initializeScopeGrantStore();
    const trainingStatusCount = await initializeTrainingStore();
    console.log("[P019A] OAuth store ready", { hydratedCount });
    console.log("[P019B] Assignment index ready", { assignmentIndexCount });
    console.log("[P026A] Location goals ready");
    console.log("[P026B] Seller goals ready");
    console.log("[P027A] Weekly report integration ready");
    console.log("[P028C] Scope grants ready", { scopeGrantCount });
    console.log("[P028D] Read-context switching ready");
    console.log("[TRAINING-P01] Training status bridge ready", { trainingStatusCount });
    app.listen(port, () => console.log(`GHL app listening on port ${port}`));
  } catch (error: any) { console.error("[MPP] startup failed", { message: error?.message ?? "unknown" }); process.exit(1); }
}
start();