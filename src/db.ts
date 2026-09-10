const { Pool } = require("pg");

let pool: any = null;

function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  pool = new Pool({ connectionString });
  return pool;
}

export async function initializeOAuthStore() {
  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS oauth_installations (
      resource_id   TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL,
      company_id    TEXT,
      location_id   TEXT,
      user_type     TEXT NOT NULL,
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at    TIMESTAMPTZ NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const result = await db.query(`
    SELECT
      resource_id,
      resource_type,
      company_id,
      location_id,
      user_type,
      access_token,
      refresh_token,
      expires_at
    FROM oauth_installations
  `);

  return result.rows;
}

export async function upsertOAuthInstallation(details: {
  resourceId: string;
  resourceType: "company" | "location";
  companyId?: string;
  locationId?: string;
  userType: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}) {
  const db = getPool();

  await db.query(
    `
      INSERT INTO oauth_installations (
        resource_id,
        resource_type,
        company_id,
        location_id,
        user_type,
        access_token,
        refresh_token,
        expires_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (resource_id)
      DO UPDATE SET
        resource_type = EXCLUDED.resource_type,
        company_id = EXCLUDED.company_id,
        location_id = EXCLUDED.location_id,
        user_type = EXCLUDED.user_type,
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    `,
    [
      details.resourceId,
      details.resourceType,
      details.companyId ?? null,
      details.locationId ?? null,
      details.userType,
      details.accessToken,
      details.refreshToken,
      details.expiresAt,
    ]
  );
}

export async function updateOAuthTokenPair(details: {
  resourceId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}) {
  const db = getPool();

  const result = await db.query(
    `
      UPDATE oauth_installations
      SET
        access_token = $2,
        refresh_token = $3,
        expires_at = $4,
        updated_at = NOW()
      WHERE resource_id = $1
    `,
    [
      details.resourceId,
      details.accessToken,
      details.refreshToken,
      details.expiresAt,
    ]
  );

  if (result.rowCount !== 1) {
    throw new Error("OAuth installation not found during token refresh");
  }
}

export async function initializeAssignmentIndex() {
  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS mpp_assignment_index (
      location_id TEXT NOT NULL,
      ghl_user_id TEXT NOT NULL,
      record_id   TEXT NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (location_id, ghl_user_id),
      UNIQUE (location_id, record_id)
    )
  `);

  // P019B proof fixture: idempotent seed of the already-verified Sierra mapping.
  await db.query(
    `
      INSERT INTO mpp_assignment_index (
        location_id,
        ghl_user_id,
        record_id,
        updated_at
      )
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (location_id, ghl_user_id)
      DO UPDATE SET
        record_id = EXCLUDED.record_id,
        updated_at = NOW()
    `,
    [
      "e44pA2hEK8BXwer0eNYB",
      "fM1JdFIqwp0t2jRUDgo9",
      "6a9b05869290d69476eb9c0c",
    ]
  );

  const countResult = await db.query(
    `SELECT COUNT(*)::int AS count FROM mpp_assignment_index`
  );

  return countResult.rows[0]?.count ?? 0;
}

export async function getAssignmentRecordId(
  locationId: string,
  ghlUserId: string
): Promise<string | null> {
  const db = getPool();

  const result = await db.query(
    `
      SELECT record_id
      FROM mpp_assignment_index
      WHERE location_id = $1 AND ghl_user_id = $2
      LIMIT 1
    `,
    [locationId, ghlUserId]
  );

  return result.rows[0]?.record_id ?? null;
}
