import { expect } from "bun:test";
import type { TransactionMode } from "@libsql/core/api";

Bun.env.NODE_ENV = "development";
Bun.env.APP_ORIGIN = "";
Bun.env.AUTH_DEFAULT_PASSWORD = "accounting-maintenance-fixture-password";
Bun.env.DATABASE_URL = `file:/tmp/opencode/rawroute-accounting-maintenance-${crypto.randomUUID()}.db`;
Bun.env.RAWROUTE_DATA_DIR = `/tmp/opencode/rawroute-accounting-maintenance-data-${crypto.randomUUID()}`;

const { db } = await import("./db");
const { createWorkspace, ensureWorkspaceSchema } = await import("./workspaces");
const { deleteAccountingForWorkspace, ensureAccountingSchema, reconcileUsageLedger } = await import("./accounting");

await ensureWorkspaceSchema();
await ensureAccountingSchema();
const workspace = await createWorkspace("Repair deletion race");
const originalTransaction = db.transaction.bind(db);
let firstTransaction = true;
db.transaction = async (mode?: TransactionMode) => {
  const transaction = await originalTransaction(mode);
  if (firstTransaction) {
    firstTransaction = false;
    const commit = transaction.commit.bind(transaction);
    transaction.commit = async () => {
      await commit();
      await db.execute({ sql: "UPDATE workspaces SET status='deleting' WHERE id=?", args: [workspace.id] });
      await deleteAccountingForWorkspace(workspace.id);
      await db.execute({ sql: "DELETE FROM workspaces WHERE id=?", args: [workspace.id] });
    };
  }
  return transaction;
};

try {
  await expect(reconcileUsageLedger(workspace.id)).rejects.toThrow("Workspace is unavailable.");
} finally {
  db.transaction = originalTransaction;
}
for (const table of ["budget_windows", "budget_counters", "usage_rollups"]) {
  const rows = await db.execute({ sql: `SELECT 1 FROM ${table} WHERE workspace_id=?`, args: [workspace.id] });
  expect(rows.rows).toHaveLength(0);
}
