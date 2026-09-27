const args = process.argv.slice(2);
const workspaceFlag = args.indexOf("--workspace");
const workspaceId = workspaceFlag >= 0 ? args[workspaceFlag + 1] : undefined;

if (!workspaceId || args.length !== 2 || workspaceFlag !== 0) {
  console.error("Usage: bun maintenance.js --workspace <workspace-id>");
  process.exit(2);
}

const { ensureWorkspaceSchema } = await import("../src/lib/workspaces");
const { ensureAccountingSchema, reconcileUsageLedger } = await import("../src/lib/accounting");

await ensureWorkspaceSchema();
await ensureAccountingSchema();
const result = await reconcileUsageLedger(workspaceId);
console.log(JSON.stringify({ workspaceId, ...result }));
