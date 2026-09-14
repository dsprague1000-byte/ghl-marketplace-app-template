const { Pool } = require("pg");

let pool: any = null;

function getScopePool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  pool = new Pool({ connectionString });
  return pool;
}

export async function initializeScopeGrantStore() {
  const db = getScopePool();
  await db.query(`CREATE TABLE IF NOT EXISTS mpp_scope_grants (
    id BIGSERIAL PRIMARY KEY,
    ghl_user_id TEXT NOT NULL,
    assignment_record_id TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type = 'location'),
    scope_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (ghl_user_id, scope_type, scope_id)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_mpp_scope_grants_user
    ON mpp_scope_grants (ghl_user_id, scope_type, scope_id)`);
  await db.query(`INSERT INTO mpp_scope_grants (ghl_user_id, assignment_record_id, scope_type, scope_id)
    SELECT ghl_user_id, record_id, 'location', location_id FROM mpp_assignment_index
    ON CONFLICT (ghl_user_id, scope_type, scope_id) DO NOTHING`);
  const result = await db.query(`SELECT COUNT(*)::int AS count FROM mpp_scope_grants`);
  return result.rows[0]?.count ?? 0;
}

export async function upsertScopeGrant(details:{ghlUserId:string;assignmentRecordId:string;scopeId:string}) {
  const result = await getScopePool().query(`INSERT INTO mpp_scope_grants
    (ghl_user_id,assignment_record_id,scope_type,scope_id,created_at)
    VALUES ($1,$2,'location',$3,NOW())
    ON CONFLICT (ghl_user_id,scope_type,scope_id)
    DO UPDATE SET assignment_record_id=EXCLUDED.assignment_record_id
    RETURNING id,ghl_user_id,assignment_record_id,scope_type,scope_id,created_at`,
    [details.ghlUserId,details.assignmentRecordId,details.scopeId]);
  return result.rows[0];
}

export async function hasLocationScopeGrant(ghlUserId:string,scopeId:string) {
  const result = await getScopePool().query(`SELECT 1 FROM mpp_scope_grants
    WHERE ghl_user_id=$1 AND scope_type='location' AND scope_id=$2 LIMIT 1`,[ghlUserId,scopeId]);
  return result.rowCount === 1;
}

export async function getLocationScopeGrants(ghlUserId:string) {
  const result = await getScopePool().query(`SELECT scope_id,assignment_record_id,created_at
    FROM mpp_scope_grants WHERE ghl_user_id=$1 AND scope_type='location' ORDER BY scope_id`,[ghlUserId]);
  return result.rows;
}
