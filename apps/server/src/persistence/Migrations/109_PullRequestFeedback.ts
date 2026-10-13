import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_feedback_threads (
      thread_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      identity TEXT NOT NULL,
      snapshot_json TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_feedback_deliveries (
      thread_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      command_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'superseded', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      error TEXT,
      PRIMARY KEY (thread_id, fingerprint)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_feedback_delivery_budget
    ON pull_request_feedback_deliveries(thread_id, created_at, state)
  `;
});
