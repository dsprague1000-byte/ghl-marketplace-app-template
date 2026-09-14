import crypto from "crypto";
import { Express, Response } from "express";
const { Pool } = require("pg");
import { hasLocationScopeGrant } from "./scope-grants";

let pool: any = null;

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  pool = new Pool({ connectionString });
  return pool;
}

export async function initializeTrainingStore() {
  const db = getPool();
  await db.query(`CREATE TABLE IF NOT EXISTS mpp_training_status (
    mpp_user_id TEXT NOT NULL,
    location_id TEXT,
    training_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('enrolled','completed')),
    completed_at TIMESTAMPTZ,
    source TEXT NOT NULL DEFAULT 'ghl_courses',
    source_product_id TEXT,
    gc_contact_id TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (mpp_user_id, training_key)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_mpp_training_status_location
    ON mpp_training_status (location_id, mpp_user_id)`);
  const result = await db.query(`SELECT COUNT(*)::int AS count FROM mpp_training_status`);
  return result.rows[0]?.count ?? 0;
}

export async function upsertTrainingCompletion(details: {
  mppUserId: string;
  locationId?: string | null;
  trainingKey: string;
  completedAt: string;
  sourceProductId?: string | null;
  gcContactId?: string | null;
}) {
  const result = await getPool().query(`INSERT INTO mpp_training_status
    (mpp_user_id,location_id,training_key,status,completed_at,source,source_product_id,gc_contact_id,updated_at)
    VALUES ($1,$2,$3,'completed',$4,'ghl_courses',$5,$6,NOW())
    ON CONFLICT (mpp_user_id,training_key) DO UPDATE SET
      location_id=COALESCE(EXCLUDED.location_id,mpp_training_status.location_id),
      status='completed',
      completed_at=EXCLUDED.completed_at,
      source='ghl_courses',
      source_product_id=EXCLUDED.source_product_id,
      gc_contact_id=EXCLUDED.gc_contact_id,
      updated_at=NOW()
    RETURNING mpp_user_id,location_id,training_key,status,completed_at,source,source_product_id,gc_contact_id,updated_at`,
    [details.mppUserId, details.locationId ?? null, details.trainingKey, details.completedAt,
      details.sourceProductId ?? null, details.gcContactId ?? null]);
  return result.rows[0];
}

export async function getTrainingStatus(mppUserId: string) {
  const result = await getPool().query(`SELECT mpp_user_id,location_id,training_key,status,completed_at,
    source,source_product_id,gc_contact_id,updated_at FROM mpp_training_status
    WHERE mpp_user_id=$1 ORDER BY training_key`, [mppUserId]);
  return result.rows;
}

function safeSecretMatches(received: string, expected: string) {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendTrainingError(res: Response, error: any, fallback = "training_request_failed") {
  const status = error?.statusCode ?? 500;
  console.error("[TRAINING] request error", { status, message: error?.message ?? "unknown" });
  return res.status(status).json({ error: error?.message ?? fallback });
}

export function registerTrainingRoutes(app: Express, deps: {
  resolveTrustedAssignment: (key: string) => Promise<any>;
  isActive: (value: unknown) => boolean;
  managerRoles: Set<string>;
}) {
  app.post("/training/completion-webhook", async (req, res) => {
    try {
      const expected = String(process.env.MPP_WEBHOOK_SECRET ?? "");
      if (!expected) return res.status(503).json({ error: "Training webhook secret not configured" });
      const received = String(req.header("X-MPP-Webhook-Secret") ?? "");
      if (!safeSecretMatches(received, expected)) return res.status(401).json({ error: "Invalid webhook secret" });

      const mppUserId = String(req.body?.mpp_user_id ?? "").trim();
      const locationId = String(req.body?.location_id ?? "").trim() || null;
      const trainingKey = String(req.body?.training_key ?? "").trim();
      const productId = String(req.body?.product_id ?? "").trim() || null;
      const gcContactId = String(req.body?.gc_contact_id ?? "").trim() || null;
      const completedAtRaw = String(req.body?.completed_at ?? "").trim();
      const completedAt = completedAtRaw && !Number.isNaN(Date.parse(completedAtRaw))
        ? new Date(completedAtRaw).toISOString()
        : new Date().toISOString();

      if (!mppUserId || !trainingKey) return res.status(400).json({ error: "mpp_user_id and training_key required" });

      await upsertTrainingCompletion({
        mppUserId,
        locationId,
        trainingKey,
        completedAt,
        sourceProductId: productId,
        gcContactId,
      });
      return res.status(200).json({ ok: true });
    } catch (error: any) { return sendTrainingError(res, error, "training_completion_failed"); }
  });

  app.get("/training/status", async (req, res) => {
    try {
      const key = String(req.header("X-MPP-SSO-Key") ?? "").trim();
      if (!key) return res.status(400).json({ error: "X-MPP-SSO-Key required" });
      const viewer = await deps.resolveTrustedAssignment(key);
      if (!viewer.assignmentFound || !deps.isActive(viewer.assignment?.active)) return res.status(403).json({ error: "Active MPP assignment required" });

      const targetUserId = String(req.query?.mpp_user_id ?? viewer.userId).trim();
      if (!targetUserId) return res.status(400).json({ error: "mpp_user_id required" });
      const rows = await getTrainingStatus(targetUserId);

      if (targetUserId === viewer.userId) return res.json({ mpp_user_id: targetUserId, training: rows });
      if (!deps.managerRoles.has(viewer.assignment.mpp_role)) return res.status(403).json({ error: "Training status view not permitted" });

      const visible = [];
      for (const row of rows) {
        if (row.location_id && await hasLocationScopeGrant(viewer.userId, row.location_id)) visible.push(row);
      }
      return res.json({ mpp_user_id: targetUserId, training: visible });
    } catch (error: any) { return sendTrainingError(res, error, "training_status_failed"); }
  });
}
