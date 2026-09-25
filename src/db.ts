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
  await db.query(`CREATE TABLE IF NOT EXISTS oauth_callback_receipts (
    code_hash TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('pending','complete','failed')),
    company_id TEXT,
    location_id TEXT,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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


export async function claimOAuthCallback(codeHash: string) {
  const db = getPool();
  const inserted = await db.query(`INSERT INTO oauth_callback_receipts
    (code_hash,status,created_at,updated_at) VALUES ($1,'pending',NOW(),NOW())
    ON CONFLICT (code_hash) DO NOTHING RETURNING status,company_id,location_id,error_code`, [codeHash]);
  if (inserted.rowCount === 1) return { claimed: true, ...inserted.rows[0] };
  const existing = await db.query(`SELECT status,company_id,location_id,error_code
    FROM oauth_callback_receipts WHERE code_hash=$1 LIMIT 1`, [codeHash]);
  return { claimed: false, ...(existing.rows[0] ?? { status: "pending" }) };
}

export async function getOAuthCallbackReceipt(codeHash: string) {
  const result = await getPool().query(`SELECT status,company_id,location_id,error_code
    FROM oauth_callback_receipts WHERE code_hash=$1 LIMIT 1`, [codeHash]);
  return result.rows[0] ?? null;
}

export async function completeOAuthCallback(codeHash: string, companyId: string|null, locationId: string|null) {
  await getPool().query(`UPDATE oauth_callback_receipts SET status='complete',
    company_id=$2,location_id=$3,error_code=NULL,updated_at=NOW() WHERE code_hash=$1`,
    [codeHash, companyId, locationId]);
}

export async function failOAuthCallback(codeHash: string, errorCode: string) {
  await getPool().query(`UPDATE oauth_callback_receipts SET status='failed',
    error_code=$2,updated_at=NOW() WHERE code_hash=$1 AND status='pending'`, [codeHash, errorCode]);
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

  await db.query(`ALTER TABLE mpp_shift_logs
    ADD COLUMN IF NOT EXISTS team_record_id TEXT,
    ADD COLUMN IF NOT EXISTS team_name_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS review_status TEXT,
    ADD COLUMN IF NOT EXISTS manager_note TEXT,
    ADD COLUMN IF NOT EXISTS reviewed_by_ghl_user_id TEXT,
    ADD COLUMN IF NOT EXISTS reviewed_by_name TEXT,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS review_version INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_review_action_id TEXT`);
  await db.query(`UPDATE mpp_shift_logs SET review_status=CASE status
    WHEN 'verified' THEN 'Verified' WHEN 'rejected' THEN 'Needs Review' ELSE 'Pending' END
    WHERE review_status IS NULL`);
  await db.query(`ALTER TABLE mpp_shift_logs ALTER COLUMN review_status SET DEFAULT 'Pending'`);
  await db.query(`ALTER TABLE mpp_shift_logs ALTER COLUMN review_status SET NOT NULL`);
  await db.query(`CREATE TABLE IF NOT EXISTS mpp_review_events (
    id BIGSERIAL PRIMARY KEY,
    activity_report_id BIGINT NOT NULL REFERENCES mpp_shift_logs(id),
    location_id TEXT NOT NULL,
    team_record_id TEXT NOT NULL,
    actor_ghl_user_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    prior_status TEXT NOT NULL,
    resulting_status TEXT NOT NULL,
    manager_note TEXT,
    action_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    expected_version INTEGER NOT NULL,
    resulting_version INTEGER NOT NULL,
    UNIQUE(activity_report_id, action_id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS mpp_reporting_team_destinations (
    location_id TEXT NOT NULL,
    ghl_user_id TEXT NOT NULL,
    team_record_id TEXT NOT NULL,
    team_name TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(location_id, ghl_user_id, team_record_id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS mpp_sm_team_management (
    location_id TEXT NOT NULL,
    sm_user_id TEXT NOT NULL,
    team_record_id TEXT NOT NULL,
    assignment_record_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(location_id, sm_user_id),
    UNIQUE(location_id, team_record_id)
  )`);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_mpp_shift_logs_location_date ON mpp_shift_logs (location_id, shift_date DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_mpp_shift_logs_seller_date ON mpp_shift_logs (location_id, seller_user_id, shift_date DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_mpp_shift_logs_review_queue ON mpp_shift_logs (location_id, team_record_id, review_status, shift_date, id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_mpp_review_events_report_time ON mpp_review_events (activity_report_id, occurred_at)`);

  const fixtureLocation=process.env.MPP_TEST_FIXTURE_LOCATION_ID;
  const fixtureSeller=process.env.MPP_TEST_FIXTURE_SELLER_USER_ID;
  const fixtureTeam=process.env.MPP_TEST_FIXTURE_TEAM_ID;
  const fixtureTeamName=process.env.MPP_TEST_FIXTURE_TEAM_NAME;
  if (fixtureLocation && fixtureSeller && fixtureTeam && fixtureTeamName) {
    await db.query(`INSERT INTO mpp_reporting_team_destinations
      (location_id,ghl_user_id,team_record_id,team_name,active,updated_at)
      VALUES ($1,$2,$3,$4,TRUE,NOW())
      ON CONFLICT(location_id,ghl_user_id,team_record_id) DO UPDATE SET
      team_name=EXCLUDED.team_name,active=TRUE,updated_at=NOW()`,
      [fixtureLocation,fixtureSeller,fixtureTeam,fixtureTeamName]);
  }

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

export async function upsertReportingTeamDestination(details:any) {
  await getPool().query(`INSERT INTO mpp_reporting_team_destinations
    (location_id,ghl_user_id,team_record_id,team_name,active,updated_at)
    VALUES ($1,$2,$3,$4,$5,NOW())
    ON CONFLICT(location_id,ghl_user_id,team_record_id) DO UPDATE SET
    team_name=EXCLUDED.team_name,active=EXCLUDED.active,updated_at=NOW()`,
    [details.locationId,details.ghlUserId,details.teamRecordId,details.teamName,details.active !== false]);
}

export async function getReportingTeamDestinations(locationId:string, ghlUserId:string) {
  const result=await getPool().query(`SELECT team_record_id,team_name FROM mpp_reporting_team_destinations
    WHERE location_id=$1 AND ghl_user_id=$2 AND active=TRUE ORDER BY team_name,team_record_id`,[locationId,ghlUserId]);
  return result.rows;
}

export async function isValidReportingTeam(locationId:string, ghlUserId:string, teamRecordId:string) {
  const result=await getPool().query(`SELECT team_record_id,team_name FROM mpp_reporting_team_destinations
    WHERE location_id=$1 AND ghl_user_id=$2 AND team_record_id=$3 AND active=TRUE LIMIT 1`,
    [locationId,ghlUserId,teamRecordId]);
  return result.rows[0] ?? null;
}

export async function reconcileManagedTeam(details:any) {
  const db=getPool();
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    const byManager=await client.query(`SELECT team_record_id FROM mpp_sm_team_management
      WHERE location_id=$1 AND sm_user_id=$2 FOR UPDATE`,[details.locationId,details.smUserId]);
    if (byManager.rows[0] && byManager.rows[0].team_record_id !== details.teamRecordId) {
      throw Object.assign(new Error("Sales Manager has conflicting Team management assignments"),{statusCode:403});
    }
    const byTeam=await client.query(`SELECT sm_user_id FROM mpp_sm_team_management
      WHERE location_id=$1 AND team_record_id=$2 FOR UPDATE`,[details.locationId,details.teamRecordId]);
    if (byTeam.rows[0] && byTeam.rows[0].sm_user_id !== details.smUserId) {
      throw Object.assign(new Error("Managed Team is already assigned to another Sales Manager"),{statusCode:403});
    }
    await client.query(`INSERT INTO mpp_sm_team_management
      (location_id,sm_user_id,team_record_id,assignment_record_id,updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT(location_id,sm_user_id) DO UPDATE SET
      team_record_id=EXCLUDED.team_record_id,assignment_record_id=EXCLUDED.assignment_record_id,updated_at=NOW()`,
      [details.locationId,details.smUserId,details.teamRecordId,details.assignmentRecordId]);
    await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function createShiftLog(details: any) {
  const result = await getPool().query(`INSERT INTO mpp_shift_logs
    (location_id,seller_user_id,seller_name,assignment_record_id,team_record_id,team_name_snapshot,
     shift_date,opportunities,memberships_sold,notes,review_status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Pending')
    RETURNING id,team_record_id,team_name_snapshot,shift_date,opportunities,memberships_sold,notes,
      review_status,review_version,created_at`,
    [details.locationId,details.sellerUserId,details.sellerName,details.assignmentRecordId,
    details.teamRecordId,details.teamName,details.shiftDate,details.opportunities,
    details.membershipsSold,details.notes ?? ""]);
  return result.rows[0];
}

export async function getSellerShiftLogs(locationId: string, sellerUserId: string, limit=20) {
  const safeLimit=Math.max(1,Math.min(100,Math.floor(limit)));
  const result=await getPool().query(`SELECT id,team_record_id,team_name_snapshot,shift_date,
    opportunities,memberships_sold,notes,review_status,manager_note,reviewed_by_name,reviewed_at,
    review_version,created_at FROM mpp_shift_logs WHERE location_id=$1 AND seller_user_id=$2
    ORDER BY shift_date DESC,id DESC LIMIT $3`,[locationId,sellerUserId,safeLimit]);
  return result.rows;
}

export async function getSellerShiftLog(locationId:string,sellerUserId:string,logId:string) {
  const result=await getPool().query(`SELECT id,team_record_id,team_name_snapshot,shift_date,
    opportunities,memberships_sold,notes,review_status,manager_note,reviewed_by_name,reviewed_at,
    review_version,created_at FROM mpp_shift_logs
    WHERE id=$1 AND location_id=$2 AND seller_user_id=$3 LIMIT 1`,[logId,locationId,sellerUserId]);
  return result.rows[0] ?? null;
}

export async function getReviewQueue(locationId:string,managedTeamId:string) {
  const result=await getPool().query(`SELECT id,seller_user_id,seller_name,team_record_id,
    team_name_snapshot,shift_date,opportunities,memberships_sold,notes,review_status,
    manager_note,review_version,created_at FROM mpp_shift_logs
    WHERE location_id=$1 AND team_record_id=$2 AND review_status='Pending'
    ORDER BY shift_date ASC,id ASC`,[locationId,managedTeamId]);
  return result.rows;
}

export async function getReviewFollowUps(locationId:string,managedTeamId:string) {
  const result=await getPool().query(`SELECT id,seller_user_id,seller_name,team_record_id,
    team_name_snapshot,shift_date,opportunities,memberships_sold,notes,review_status,
    manager_note,review_version,created_at FROM mpp_shift_logs
    WHERE location_id=$1 AND team_record_id=$2 AND review_status='Needs Review'
    ORDER BY shift_date ASC,id ASC`,[locationId,managedTeamId]);
  return result.rows;
}

export async function getShiftLogForReview(locationId:string,managedTeamId:string,logId:string) {
  const result=await getPool().query(`SELECT id,seller_user_id,seller_name,team_record_id,
    team_name_snapshot,shift_date,opportunities,memberships_sold,notes,review_status,
    manager_note,reviewed_by_ghl_user_id,reviewed_by_name,reviewed_at,review_version,created_at
    FROM mpp_shift_logs WHERE id=$1 AND location_id=$2 AND team_record_id=$3 LIMIT 1`,
    [logId,locationId,managedTeamId]);
  return result.rows[0] ?? null;
}

export async function reviewShiftLog(details:any) {
  const db=getPool();
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    const duplicate=await client.query(`SELECT resulting_status,resulting_version,manager_note,occurred_at
      FROM mpp_review_events WHERE activity_report_id=$1 AND action_id=$2 LIMIT 1`,
      [details.logId,details.actionId]);
    if (duplicate.rows[0]) {
      const existing=await client.query(`SELECT id,seller_user_id,seller_name,team_record_id,
        team_name_snapshot,shift_date,opportunities,memberships_sold,notes,review_status,
        manager_note,reviewed_by_ghl_user_id,reviewed_by_name,reviewed_at,review_version
        FROM mpp_shift_logs WHERE id=$1 AND location_id=$2 AND team_record_id=$3 LIMIT 1`,
        [details.logId,details.locationId,details.managedTeamId]);
      await client.query("COMMIT");
      return existing.rows[0] ? {log:existing.rows[0],idempotent:true} : null;
    }
    const locked=await client.query(`SELECT * FROM mpp_shift_logs
      WHERE id=$1 AND location_id=$2 AND team_record_id=$3 FOR UPDATE`,
      [details.logId,details.locationId,details.managedTeamId]);
    const current=locked.rows[0];
    if (!current) { await client.query("ROLLBACK"); return null; }
    if (Number(current.review_version)!==Number(details.expectedVersion)) {
      throw Object.assign(new Error("Review changed since it was opened"),{statusCode:409});
    }
    const prior=String(current.review_status);
    const next=String(details.decision);
    if (!((prior==="Pending"&&(next==="Verified"||next==="Needs Review")) ||
      (prior==="Needs Review"&&next==="Verified"))) {
      throw Object.assign(new Error("Review transition is not permitted"),{statusCode:409});
    }
    const suppliedNote=String(details.managerNote??"").trim();
    const resultingNote=suppliedNote || String(current.manager_note??"").trim();
    if (next==="Needs Review"&&!suppliedNote) {
      throw Object.assign(new Error("Manager Note is required for Needs Review"),{statusCode:400});
    }
    if (prior==="Needs Review"&&next==="Verified"&&!resultingNote) {
      throw Object.assign(new Error("An existing or supplied Manager Note is required"),{statusCode:400});
    }
    const legacyStatus=next==="Verified"?"verified":"rejected";
    const nextVersion=Number(current.review_version)+1;
    const updated=await client.query(`UPDATE mpp_shift_logs SET
      review_status=$4,manager_note=$5,reviewed_by_ghl_user_id=$6,reviewed_by_name=$7,
      reviewed_at=NOW(),review_version=$8,last_review_action_id=$9,status=$10,
      verified_by=$6,verified_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND location_id=$2 AND team_record_id=$3
      RETURNING id,seller_user_id,seller_name,team_record_id,team_name_snapshot,shift_date,
        opportunities,memberships_sold,notes,review_status,manager_note,
        reviewed_by_ghl_user_id,reviewed_by_name,reviewed_at,review_version`,
      [details.logId,details.locationId,details.managedTeamId,next,resultingNote||null,
       details.reviewerUserId,details.reviewerName,nextVersion,details.actionId,legacyStatus]);
    await client.query(`INSERT INTO mpp_review_events
      (activity_report_id,location_id,team_record_id,actor_ghl_user_id,actor_name,
       prior_status,resulting_status,manager_note,action_id,correlation_id,
       expected_version,resulting_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [details.logId,details.locationId,details.managedTeamId,details.reviewerUserId,
       details.reviewerName,prior,next,resultingNote||null,details.actionId,
       details.correlationId,details.expectedVersion,nextVersion]);
    await client.query("COMMIT");
    return {log:updated.rows[0],idempotent:false};
  } catch(error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
  finally { client.release(); }
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

export async function getVerifiedPerformanceWindow(locationId:string,startDate:string,endDateExclusive:string) {
  const totalResult=await getPool().query(`SELECT COUNT(*)::int AS log_count,
    COALESCE(SUM(opportunities),0)::int AS opportunities,
    COALESCE(SUM(memberships_sold),0)::int AS memberships_sold
    FROM mpp_shift_logs WHERE location_id=$1 AND status='verified'
    AND shift_date >= $2::date AND shift_date < $3::date`,[locationId,startDate,endDateExclusive]);
  const sellerResult=await getPool().query(`SELECT seller_user_id,seller_name,
    COALESCE(SUM(opportunities),0)::int AS opportunities,
    COALESCE(SUM(memberships_sold),0)::int AS memberships_sold
    FROM mpp_shift_logs WHERE location_id=$1 AND status='verified'
    AND shift_date >= $2::date AND shift_date < $3::date
    GROUP BY seller_user_id,seller_name ORDER BY memberships_sold DESC,opportunities DESC,seller_name ASC`,
    [locationId,startDate,endDateExclusive]);
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
