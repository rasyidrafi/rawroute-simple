import { strict as assert } from "node:assert";

const state = await Bun.file(Bun.env.ACCOUNTING_QUEUE_CRASH_STATE!).json() as { databaseUrl: string; workspaceId: string; attemptId: string };
Bun.env.NODE_ENV = "development"; Bun.env.APP_ORIGIN = ""; Bun.env.AUTH_DEFAULT_PASSWORD = "accounting-queue-crash"; Bun.env.DATABASE_URL = state.databaseUrl;
const accounting = await import("./accounting"); const { db } = await import("./db");
await accounting.ensureAccountingSchema(); await accounting.recoverAccountingJobs();
const event = (await db.execute({ sql: "SELECT status,cost_micros FROM usage_events WHERE workspace_id=? AND attempt_id=?", args: [state.workspaceId, state.attemptId] })).rows[0]; const counter = (await db.execute({ sql: "SELECT spent_micros,reserved_micros FROM budget_counters WHERE workspace_id=?", args: [state.workspaceId] })).rows[0]; const reservation = (await db.execute({ sql: "SELECT state FROM budget_reservations WHERE workspace_id=? AND attempt_id=?", args: [state.workspaceId, state.attemptId] })).rows[0];
assert.equal(event?.status, 200); assert.equal(event?.cost_micros, 10); assert.equal(counter?.spent_micros, 10); assert.equal(counter?.reserved_micros, 0); assert.equal(reservation?.state, "settled"); await accounting.beginAccountingShutdown(); db.close();
