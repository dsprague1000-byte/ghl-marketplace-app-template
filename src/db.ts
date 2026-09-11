const { Pool } = require("pg");

let pool: any = null;

function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  pool = new Pool({ connectionString });
  return pool;
}

export async function initializeOAuthStore() {
  const db = getPool();
  await db.query(`CREATE TABLE IF NOT EXISTS oauth_installations (
    resource_id TEXT PRIMARY KEY, resource_type TEXT NOT NULL, company_id TEXT,
    location_id TEXT, user_type TEXT NOT NULL, access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const result = await db.query(`SELECT resource_id, resource_type, company_id, location_id,
    user_type, access_token, refresh_token, expires_at FROM oauth_installations`);
  return result.rows;
}

export async function upsertOAuthInstallation(details: any) {
  const db = getPool();
  await db.query(`INSERT INTO oauth_installations
    (resource_id, resource_type, company_id, location_id, user_type, access_token, refresh_token, expires_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    ON CONFLICT (resource_id) DO UPDATE SET resource_type=EXCLUDED.resource_type,
    company_id=EXCLUDED.company_id, location_id=EXCLUDED.location_id, user_type=EXCLUDED.user_type,
    access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token,
    expires_at=EXCLUDED.expires_at, updated_at=NOW()`, [details.resourceId, details.resourceType,
    details.companyId ?? null, details.locationId ?? null, details.userType, details.accessToken,
    details.refreshToken, details.expiresAt]);
}

export async function updateOAuthTokenPair(details: any) {
  const db = getPool();
  const result = await db.query(`UPDATE oauth_installations SET access_token=$2, refresh_token=$3,
    expires_at=$4, updated_at=NOW() WHERE resource_id=$1`,
    [details.resourceId, details.accessToken, details.refreshToken, details.expiresAt]);
  if (result.rowCount !== 1) throw new Error("OAuth installation not found during token refresh");
}

export async function initializeAssignmentIndex() {
  const db = getPool();
  await db.query(`CREATE TABLE IF NOT EXISTS mpp_assignment_index (
    location_id TEXT NOT NULL, ghl_user_id TEXT NOT NULL, record_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (location_id, ghl_user_id),
    UNIQUE (location_id, record_id))`);
  await db.query(`INSERT INTO mpp_assignment_index (location_id, ghl_user_id, record_id, updated_at)
    VALUES ($1,$2,$3,NOW()) ON CONFLICT (location_id, ghl_user_id)
    DO UPDATE SET record_id=EXCLUDED.record_id, updated_at=NOW()`,
    ["e44pA2hEK8BXwer0eNYB", "fM1JdFIqwp0t2jRUDgo9", "6a9b05869290d69476eb9c0c"]);
  const result = await db.query(`SELECT COUNT(*)::int AS count FROM mpp_assignment_index`);
  return result.rows[0]?.count ?? 0;
}

export async function getAssignmentRecordId(locationId: string, ghlUserId: string): Promise<string|null> {
  const result = await getPool().query(`SELECT record_id FROM mpp_assignment_index
    WHERE location_id=$1 AND ghl_user_id=$2 LIMIT 1`, [locationId, ghlUserId]);
  return result.rows[0]?.record_id ?? null;
}

export async function upsertAssignmentIndex(locationId: string, ghlUserId: string, recordId: string) {
  await getPool().query(`INSERT INTO mpp_assignment_index (location_id, ghl_user_id, record_id, updated_at)
    VALUES ($1,$2,$3,NOW()) ON CONFLICT (location_id, ghl_user_id)
    DO UPDATE SET record_id=EXCLUDED.record_id, updated_at=NOW()`, [locationId, ghlUserId, recordId]);
}

export async function initializePerformanceStore() {
  const db = getPool();
  await db.query(`CREATE TABLE IF NOT EXISTS mpp_shift_logs (
    id BIGSERIAL PRIMARY KEY, location_id TEXT NOT NULL, seller_user_id TEXT NOT NULL,
    seller_name TEXT NOT NULL, assignment_record_id TEXT NOT NULL, shift_date DATE NOT NULL,
    opportunities INTEGER NOT NULL CHECK (opportunities >= 0), memberships_sold INTEGER NOT NULL CHECK (memberships_sold >= 0),
    notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','verified','rejected')), verified_by TEXT, verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_mpp_shift_logs_location_date ON mpp_shift_logs (location_id, shift_date DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_mpp_shift_logs_seller_date ON mpp_shift_logs (location_id, seller_user_id, shift_date DESC)`);

  await db.query(`CREATE TABLE IF NOT EXISTS mpp_location_goals (
    location_id TEXT NOT NULL,
    goal_month TEXT NOT NULL CHECK (goal_month ~ '^\\d{4}-\\d{2}$'),
    memberships_target INTEGER NOT NULL CHECK (memberships_target >= 0),
    conversion_target NUMERIC(6,5) NOT NULL CHECK (conversion_target >= 0 AND conversion_target <= 1),
    set_by_user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (location_id, goal_month)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS mpp_seller_goals (
    location_id TEXT NOT NULL,
    seller_user_id TEXT NOT NULL,
    goal_month TEXT NOT NULL CHECK (goal_month ~ '^\\d{4}-\\d{2}$'),
    conversion_target NUMERIC(6,5) NOT NULL CHECK (conversion_target >= 0 AND conversion_target <= 1),
    set_by_user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (location_id, seller_user_id, goal_month)
  )`);
}

export async function createShiftLog(details: any) {
  const result = await getPool().query(`INSERT INTO mpp_shift_logs
    (location_id,seller_user_id,seller_name,assignment_record_id,shift_date,opportunities,memberships_sold,notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id,shift_date,opportunities,memberships_sold,notes,status,created_at`,
    [details.locationId,details.sellerUserId,details.sellerName,details.assignmentRecordId,
    details.shiftDate,details.opportunities,details.membershipsSold,details.notes ?? ""]);
  return result.rows[0];
}

export async function getSellerShiftLogs(locationId: string, sellerUserId: string, limit=20) {
  const safeLimit=Math.max(1,Math.min(100,Math.floor(limit)));
  const result=await getPool().query(`SELECT id,shift_date,opportunities,memberships_sold,notes,status,
    verified_by,verified_at,created_at FROM mpp_shift_logs WHERE location_id=$1 AND seller_user_id=$2
    ORDER BY shift_date DESC,id DESC LIMIT $3`,[locationId,sellerUserId,safeLimit]);
  return result.rows;
}

export async function getReviewQueue(locationId:string) {
  const result=await getPool().query(`SELECT id,seller_user_id,seller_name,shift_date,opportunities,
    memberships_sold,notes,status,created_at FROM mpp_shift_logs WHERE location_id=$1 AND status='submitted'
    ORDER BY shift_date ASC,id ASC`,[locationId]);
  return result.rows;
}

export async function reviewShiftLog(details:any) {
  const result=await getPool().query(`UPDATE mpp_shift_logs SET status=$4,verified_by=$3,verified_at=NOW(),updated_at=NOW()
    WHERE id=$1 AND location_id=$2 AND status='submitted'
    RETURNING id,seller_user_id,seller_name,shift_date,opportunities,memberships_sold,status,verified_by,verified_at`,
    [details.logId,details.locationId,details.reviewerUserId,details.decision]);
  return result.rows[0] ?? null;
}

export async function getPerformanceRollup(details:any) {
  const sellerFilter=details.sellerUserId ? "AND seller_user_id = $4" : "";
  const params=details.sellerUserId ? [details.locationId,details.startDate,details.endDate,details.sellerUserId]
    : [details.locationId,details.startDate,details.endDate];
  const totalResult=await getPool().query(`SELECT COUNT(*)::int AS log_count,
    COALESCE(SUM(opportunities),0)::int AS opportunities, COALESCE(SUM(memberships_sold),0)::int AS memberships_sold,
    COUNT(*) FILTER (WHERE status='verified')::int AS verified_count,
    COUNT(*) FILTER (WHERE status='submitted')::int AS pending_count,
    COUNT(*) FILTER (WHERE status='rejected')::int AS rejected_count FROM mpp_shift_logs
    WHERE location_id=$1 AND shift_date >= $2::date AND shift_date < $3::date ${sellerFilter}`,params);
  const sellerResult=await getPool().query(`SELECT seller_user_id,seller_name,COUNT(*)::int AS log_count,
    COALESCE(SUM(opportunities),0)::int AS opportunities,COALESCE(SUM(memberships_sold),0)::int AS memberships_sold,
    COUNT(*) FILTER (WHERE status='verified')::int AS verified_count,
    COUNT(*) FILTER (WHERE status='submitted')::int AS pending_count FROM mpp_shift_logs
    WHERE location_id=$1 AND shift_date >= $2::date AND shift_date < $3::date ${sellerFilter}
    GROUP BY seller_user_id,seller_name ORDER BY memberships_sold DESC,opportunities DESC,seller_name ASC`,params);
  return {totals:totalResult.rows[0],sellers:sellerResult.rows};
}

export async function upsertLocationGoal(details:{locationId:string;month:string;membershipsTarget:number;conversionTarget:number;setByUserId:string}) {
  const result=await getPool().query(`INSERT INTO mpp_location_goals
    (location_id,goal_month,memberships_target,conversion_target,set_by_user_id,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
    ON CONFLICT (location_id,goal_month) DO UPDATE SET memberships_target=EXCLUDED.memberships_target,
    conversion_target=EXCLUDED.conversion_target,set_by_user_id=EXCLUDED.set_by_user_id,updated_at=NOW()
    RETURNING location_id,goal_month,memberships_target,conversion_target,set_by_user_id,updated_at`,
    [details.locationId,details.month,details.membershipsTarget,details.conversionTarget,details.setByUserId]);
  return result.rows[0];
}

export async function getLocationGoal(locationId:string, month:string) {
  const result=await getPool().query(`SELECT location_id,goal_month,memberships_target,conversion_target,
    set_by_user_id,updated_at FROM mpp_location_goals WHERE location_id=$1 AND goal_month=$2 LIMIT 1`,
    [locationId,month]);
  return result.rows[0] ?? null;
}

export async function upsertSellerGoal(details:{locationId:string;sellerUserId:string;month:string;conversionTarget:number;setByUserId:string}) {
  const result=await getPool().query(`INSERT INTO mpp_seller_goals
    (location_id,seller_user_id,goal_month,conversion_target,set_by_user_id,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
    ON CONFLICT (location_id,seller_user_id,goal_month) DO UPDATE SET
    conversion_target=EXCLUDED.conversion_target,set_by_user_id=EXCLUDED.set_by_user_id,updated_at=NOW()
    RETURNING seller_user_id,goal_month,conversion_target,set_by_user_id,updated_at`,
    [details.locationId,details.sellerUserId,details.month,details.conversionTarget,details.setByUserId]);
  return result.rows[0];
}

export async function getSellerGoal(locationId:string,sellerUserId:string,month:string) {
  const result=await getPool().query(`SELECT seller_user_id,goal_month,conversion_target,set_by_user_id,updated_at
    FROM mpp_seller_goals WHERE location_id=$1 AND seller_user_id=$2 AND goal_month=$3 LIMIT 1`,
    [locationId,sellerUserId,month]);
  return result.rows[0] ?? null;
}

export async function getSellerGoalsForLocation(locationId:string,month:string) {
  const result=await getPool().query(`SELECT seller_user_id,goal_month,conversion_target,set_by_user_id,updated_at
    FROM mpp_seller_goals WHERE location_id=$1 AND goal_month=$2 ORDER BY seller_user_id`,
    [locationId,month]);
  return result.rows;
}
