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
