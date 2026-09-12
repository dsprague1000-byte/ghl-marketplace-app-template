import express, { Express, Response } from "express";
import dotenv from "dotenv";
import { GHL } from "./ghl";
import { json } from "body-parser";
import {
  createShiftLog,
  getAssignmentRecordId,
  getLocationGoal,
  getPerformanceRollup,
  getReviewQueue,
  getSellerGoal,
  getSellerGoalsForLocation,
  getSellerShiftLogs,
  getVerifiedPerformanceWindow,
  initializeAssignmentIndex,
  initializePerformanceStore,
  reviewShiftLog,
  upsertAssignmentIndex,
  upsertLocationGoal,
  upsertSellerGoal,
} from "./db";

const path = __dirname + "/ui/dist/";
dotenv.config();
const app: Express = express();
app.use(json({ type: "application/json" }));
app.use(express.static(path));

const ghl = new GHL();
const port = process.env.PORT;
const SPOKE_COMPANY_ID = "NUAR0gljpx3i4RfDQPCf";
const LPR_OBJECT = "custom_objects.location_performance_reports";
const MANAGER_ROLES = new Set(["sales_manager", "general_manager", "regional_manager", "owner"]);
const PROVISION_ROLES = new Set(["general_manager", "regional_manager", "owner"]);
const LOCATION_GOAL_WRITE_ROLES = new Set(["general_manager", "regional_manager", "owner"]);
const SELLER_GOAL_WRITE_ROLES = new Set(["sales_manager"]);
const SELLER_GOAL_READ_ALL_ROLES = new Set(["sales_manager", "general_manager", "regional_manager", "owner"]);
const WEEKLY_REPORT_WRITE_ROLES = new Set(["general_manager"]);

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

async function ensureLocationToken(activeLocation: string) {
  if (ghl.checkInstallationExists(activeLocation)) return;
  const company = ghl.model.installationObjects[SPOKE_COMPANY_ID];
  if (!company || company.userType !== "Company") throw Object.assign(new Error("No OAuth token available for this location"), { statusCode: 403 });
  await ghl.getLocationTokenFromCompanyToken(SPOKE_COMPANY_ID, activeLocation);
  if (!ghl.checkInstallationExists(activeLocation)) throw Object.assign(new Error("Location token exchange produced no token"), { statusCode: 403 });
}

async function getRecordById(locationId: string, recordId: string) {
  const response = await ghl.requests(locationId).get(`/objects/custom_objects.mpp_user_assignment/records/${recordId}`, { headers: { Version: "v3" } });
  return response.data?.record ?? null;
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
  }};
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
    weekStart,
    weekEnd,
    derived: { opportunities, membershipsSold, conversionRate: opportunities > 0 ? membershipsSold / opportunities : 0, sellers },
    locationGoal: locationGoal ? { goal: locationGoal, pace: pacing(month, Number(locationGoal.memberships_target), monthActual) } : null,
    report,
    reconciliation: report ? { mppSold: membershipsSold, reportedSold: report.totalMembershipsSold, difference, matches: difference === 0 } : null,
  };
}

app.get("/authorize-handler", async (req, res) => { await ghl.authorizationHandler(req.query.code as string); res.redirect("https://app.gohighlevel.com/"); });
app.post("/decrypt-sso", async (req, res) => { try { return res.send(ghl.decryptSSOData(req.body?.key)); } catch { return res.status(400).send("Invalid Key"); } });
app.get("/oauth/callback", async (req, res) => { if (!req.query.code) return res.status(200).send("MPP OAuth Callback Received"); try { await ghl.authorizationHandler(req.query.code as string); return res.status(200).send("MPP OAuth Installation Complete"); } catch (error: any) { console.error("[MPP] OAuth callback failed", { message: error?.message ?? "unknown" }); return res.status(500).send("MPP OAuth token exchange/storage failed"); } });
app.get("/oauth/token-status", (_req, res) => { const locationId = "e44pA2hEK8BXwer0eNYB"; const inst = ghl.model.installationObjects[locationId]; const keys = Object.keys(ghl.model.installationObjects); res.json({ tokenAvailable: ghl.checkInstallationExists(locationId), locationId: inst?.locationId ?? null, companyId: inst?.companyId ?? null, userType: inst?.userType ?? null, expires_in: inst?.expires_in ?? null, refreshTokenPresent: !!ghl.model.getRefreshToken(locationId), installationObjectsKeys: keys, storedKey: keys[0] ?? null }); });

app.post("/assignment-context", async (req, res) => {
  try {
    const viewer: any = await resolveTrustedAssignment(req.body?.key);
    if (!viewer.assignmentFound) return res.json({ trustedUserId: viewer.userId, activeLocation: viewer.activeLocation, tokenVerified: true, assignmentFound: false, assignment: null, capabilities: [] });
    const role = viewer.assignment.mpp_role;
    const active = isActive(viewer.assignment.active);
    const capabilities = active ? ["view_shell", ...(role === "seller" ? ["submit_shift", "view_self"] : []), ...(MANAGER_ROLES.has(role) ? ["view_location", "review_logs"] : []), ...(PROVISION_ROLES.has(role) ? ["provision_assignments"] : []), ...(LOCATION_GOAL_WRITE_ROLES.has(role) ? ["manage_location_goal"] : []), ...(SELLER_GOAL_WRITE_ROLES.has(role) ? ["manage_seller_goals"] : []), ...(WEEKLY_REPORT_WRITE_ROLES.has(role) ? ["manage_weekly_report"] : [])] : [];
    return res.json({ trustedUserId: viewer.userId, activeLocation: viewer.activeLocation, tokenVerified: true, assignmentFound: true, assignment: viewer.assignment, capabilities });
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
    return res.json({ provisioned: true, mode, locationId: identity.activeLocation, recordId, assignment: { assignment_name: targetRecord.properties?.assignment_name ?? null, ghl_user_id: targetUserId, mpp_role: normalizeRole(targetRecord.properties?.mpp_role), scope_type: targetRecord.properties?.scope_type ?? null, active: targetRecord.properties?.active ?? null } });
  } catch (error: any) { return sendSafeError(res, error, "assignment_provision_failed"); }
});

app.post("/seller/shift-log", async (req, res) => {
  try {
    const viewer: any = await resolveTrustedAssignment(req.body?.key);
    if (!viewer.assignmentFound || !isActive(viewer.assignment.active) || viewer.assignment.mpp_role !== "seller") return res.status(403).json({ error: "Seller role required" });
    const opportunities = Number(req.body?.opportunities), membershipsSold = Number(req.body?.membershipsSold), shiftDate = String(req.body?.shiftDate ?? "");
    if (!validDate(shiftDate) || !Number.isInteger(opportunities) || opportunities < 0 || !Number.isInteger(membershipsSold) || membershipsSold < 0 || membershipsSold > opportunities) return res.status(400).json({ error: "Invalid shift values" });
    const log = await createShiftLog({ locationId: viewer.activeLocation, sellerUserId: viewer.userId, sellerName: viewer.assignment.assignment_name || viewer.ssoData.userName || "Seller", assignmentRecordId: viewer.assignment.recordId, shiftDate, opportunities, membershipsSold, notes: String(req.body?.notes ?? "").slice(0, 2000) });
    return res.status(201).json({ created: true, log });
  } catch (error: any) { return sendSafeError(res, error); }
});
app.post("/seller/shift-logs", async (req, res) => { try { const viewer: any = await resolveTrustedAssignment(req.body?.key); if (!viewer.assignmentFound || !isActive(viewer.assignment.active)) return res.status(403).json({ error: "Active MPP assignment required" }); return res.json({ logs: await getSellerShiftLogs(viewer.activeLocation, viewer.userId, 30) }); } catch (error: any) { return sendSafeError(res, error); } });
app.post("/manager/review-queue", async (req, res) => { try { const viewer: any = await resolveTrustedAssignment(req.body?.key); if (!viewer.assignmentFound || !isActive(viewer.assignment.active) || !MANAGER_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Manager role required" }); return res.json({ logs: await getReviewQueue(viewer.activeLocation) }); } catch (error: any) { return sendSafeError(res, error); } });
app.post("/manager/review-shift", async (req, res) => { try { const viewer: any = await resolveTrustedAssignment(req.body?.key); if (!viewer.assignmentFound || !isActive(viewer.assignment.active) || !MANAGER_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Manager role required" }); if (!req.body?.logId || !["verified", "rejected"].includes(req.body?.decision)) return res.status(400).json({ error: "Valid logId and decision required" }); const log = await reviewShiftLog({ locationId: viewer.activeLocation, logId: String(req.body.logId), reviewerUserId: viewer.userId, decision: req.body.decision }); return log ? res.json({ reviewed: true, log }) : res.status(409).json({ error: "Shift log is not pending or was not found" }); } catch (error: any) { return sendSafeError(res, error); } });

app.post("/performance/rollup", async (req, res) => {
  try {
    const viewer: any = await resolveTrustedAssignment(req.body?.key); if (!viewer.assignmentFound || !isActive(viewer.assignment.active)) return res.status(403).json({ error: "Active MPP assignment required" });
    const month = validMonth(req.body?.month) ? String(req.body.month) : new Date().toISOString().slice(0, 7); const { startDate, endDate } = monthBounds(month); const sellerUserId = viewer.assignment.mpp_role === "seller" ? viewer.userId : undefined;
    if (!sellerUserId && !MANAGER_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Performance view not permitted" });
    const rollup = await getPerformanceRollup({ locationId: viewer.activeLocation, startDate, endDate, sellerUserId });
    const goals = sellerUserId ? [await getSellerGoal(viewer.activeLocation, sellerUserId, month)].filter(Boolean) : await getSellerGoalsForLocation(viewer.activeLocation, month);
    const goalsBySeller = new Map(goals.map((goal: any) => [goal.seller_user_id, Number(goal.conversion_target)])); const opportunities = Number(rollup.totals?.opportunities ?? 0), membershipsSold = Number(rollup.totals?.memberships_sold ?? 0);
    const sellers = rollup.sellers.map((seller: any) => { const conversionRate = Number(seller.opportunities) > 0 ? Number(seller.memberships_sold) / Number(seller.opportunities) : 0; const conversionGoal = goalsBySeller.has(seller.seller_user_id) ? goalsBySeller.get(seller.seller_user_id) : null; return { ...seller, conversionRate, conversionGoal, conversionVariance: conversionGoal === null ? null : conversionRate - Number(conversionGoal) }; });
    const selfGoal = sellerUserId && goals.length ? Number((goals[0] as any).conversion_target) : null, selfActual = opportunities > 0 ? membershipsSold / opportunities : 0;
    return res.json({ month, scope: sellerUserId ? "self" : "location", totals: { ...rollup.totals, conversionRate: selfActual }, sellers, sellerGoal: sellerUserId ? { conversionGoal: selfGoal, conversionVariance: selfGoal === null ? null : selfActual - selfGoal } : null });
  } catch (error: any) { return sendSafeError(res, error); }
});

app.post("/goals/location", async (req, res) => { try { const viewer: any = await resolveTrustedAssignment(req.body?.key); if (!viewer.assignmentFound || !isActive(viewer.assignment.active)) return res.status(403).json({ error: "Active MPP assignment required" }); const month = validMonth(req.body?.month) ? String(req.body.month) : new Date().toISOString().slice(0, 7); const goal = await getLocationGoal(viewer.activeLocation, month); const { startDate, endDate } = monthBounds(month); const performance = await getPerformanceRollup({ locationId: viewer.activeLocation, startDate, endDate }); const actual = Number(performance.totals?.memberships_sold ?? 0); return res.json({ month, goal, pace: goal ? pacing(month, Number(goal.memberships_target), actual) : null }); } catch (error: any) { return sendSafeError(res, error, "location_goal_failed"); } });
app.post("/goals/location/set", async (req, res) => { try { const viewer: any = await resolveTrustedAssignment(req.body?.key); if (!viewer.assignmentFound || !isActive(viewer.assignment.active) || !LOCATION_GOAL_WRITE_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Location goal management not permitted" }); const month = String(req.body?.month ?? ""), membershipsTarget = Number(req.body?.membershipsTarget), conversionTarget = Number(req.body?.conversionTarget); if (!validMonth(month) || !Number.isInteger(membershipsTarget) || membershipsTarget < 0 || !Number.isFinite(conversionTarget) || conversionTarget < 0 || conversionTarget > 1) return res.status(400).json({ error: "Valid month, memberships target, and conversion target required" }); const goal = await upsertLocationGoal({ locationId: viewer.activeLocation, month, membershipsTarget, conversionTarget, setByUserId: viewer.userId }); return res.json({ saved: true, goal }); } catch (error: any) { return sendSafeError(res, error, "location_goal_save_failed"); } });
app.post("/goals/seller/set", async (req, res) => { try { const viewer: any = await resolveTrustedAssignment(req.body?.key); if (!viewer.assignmentFound || !isActive(viewer.assignment.active) || !SELLER_GOAL_WRITE_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Seller goal management not permitted" }); const sellerUserId = String(req.body?.sellerUserId ?? ""), month = String(req.body?.month ?? ""), conversionTarget = Number(req.body?.conversionTarget); if (!sellerUserId || !validMonth(month) || !Number.isFinite(conversionTarget) || conversionTarget < 0 || conversionTarget > 1) return res.status(400).json({ error: "Valid seller, month, and conversion target required" }); const targetRecordId = await getAssignmentRecordId(viewer.activeLocation, sellerUserId); if (!targetRecordId) return res.status(400).json({ error: "Seller assignment is not indexed for this location" }); const targetRecord = await getRecordById(viewer.activeLocation, targetRecordId); if (!targetRecord || targetRecord.properties?.ghl_user_id !== sellerUserId || normalizeRole(targetRecord.properties?.mpp_role) !== "seller" || !isActive(targetRecord.properties?.active)) return res.status(400).json({ error: "Target must be an active Seller assignment in this location" }); const goal = await upsertSellerGoal({ locationId: viewer.activeLocation, sellerUserId, month, conversionTarget, setByUserId: viewer.userId }); return res.json({ saved: true, goal: { seller_user_id: goal.seller_user_id, goal_month: goal.goal_month, conversion_target: goal.conversion_target } }); } catch (error: any) { return sendSafeError(res, error, "seller_goal_save_failed"); } });
app.post("/goals/seller", async (req, res) => { try { const viewer: any = await resolveTrustedAssignment(req.body?.key); if (!viewer.assignmentFound || !isActive(viewer.assignment.active)) return res.status(403).json({ error: "Active MPP assignment required" }); const month = validMonth(req.body?.month) ? String(req.body.month) : new Date().toISOString().slice(0, 7); if (viewer.assignment.mpp_role === "seller") { const goal = await getSellerGoal(viewer.activeLocation, viewer.userId, month); return res.json({ month, goals: goal ? [goal] : [] }); } if (!SELLER_GOAL_READ_ALL_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Seller goal view not permitted" }); const requestedSeller = String(req.body?.sellerUserId ?? "").trim(); if (requestedSeller) { const goal = await getSellerGoal(viewer.activeLocation, requestedSeller, month); return res.json({ month, goals: goal ? [goal] : [] }); } return res.json({ month, goals: await getSellerGoalsForLocation(viewer.activeLocation, month) }); } catch (error: any) { return sendSafeError(res, error, "seller_goal_failed"); } });

/* P027A: GM weekly report workspace backed by the existing GHL Location Performance Report object. */
app.post("/reports/weekly", async (req, res) => {
  try {
    const viewer: any = await resolveTrustedAssignment(req.body?.key);
    if (!viewer.assignmentFound || !isActive(viewer.assignment.active) || !WEEKLY_REPORT_WRITE_ROLES.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Weekly report access requires General Manager role" });
    const weekStart = String(req.body?.weekStart ?? ""); if (!validDate(weekStart)) return res.status(400).json({ error: "Valid weekStart required" });
    return res.json(await buildWeeklyWorkspace(viewer, weekStart));
  } catch (error: any) { return sendSafeError(res, error, "weekly_report_failed"); }
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
      await ghl.requests(viewer.activeLocation).put(`/objects/${LPR_OBJECT}/records/${existing.id}`, { locationId: viewer.activeLocation, properties }, { headers: { Version: "v3" } });
    } else {
      await ghl.requests(viewer.activeLocation).post(`/objects/${LPR_OBJECT}/records`, { locationId: viewer.activeLocation, properties }, { headers: { Version: "v3" } });
    }
    return res.json({ saved: true, workspace: await buildWeeklyWorkspace(viewer, weekStart) });
  } catch (error: any) { return sendSafeError(res, error, "weekly_report_save_failed"); }
});

app.get("/", (_req, res) => res.sendFile(path + "index.html"));
async function start() {
  try {
    const hydratedCount = await ghl.initialize(); const assignmentIndexCount = await initializeAssignmentIndex(); await initializePerformanceStore();
    console.log("[P019A] OAuth store ready", { hydratedCount }); console.log("[P019B] Assignment index ready", { assignmentIndexCount }); console.log("[P026A] Location goals ready"); console.log("[P026B] Seller goals ready"); console.log("[P027A] Weekly report integration ready");
    app.listen(port, () => console.log(`GHL app listening on port ${port}`));
  } catch (error: any) { console.error("[MPP] startup failed", { message: error?.message ?? "unknown" }); process.exit(1); }
}
start();