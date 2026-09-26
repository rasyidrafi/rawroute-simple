import * as fs from "node:fs";
import { ensureGatewayKeyMaster, ensureGatewayKeySchema, listGatewayKeys, revealGatewayKey, type GatewayKeyFileOperations } from "./gateway-keys";
import { ensureWorkspaceSchema } from "./workspaces";

const action = process.argv[2];
if (action !== "initialize-master-only") await ensureWorkspaceSchema();

function injectedFileOperations(
  failure: "linkSync" | "unlinkSync" | "writeFileSync",
  secondaryFailure?: "unlinkSync",
): GatewayKeyFileOperations {
  return new Proxy(fs, {
    get(target, property, receiver) {
      if (property === failure || property === secondaryFailure) {
        return () => {
          const error = new Error("Injected master-key file failure") as NodeJS.ErrnoException;
          error.code = "ENOSPC";
          throw error;
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as GatewayKeyFileOperations;
}

if (action === "initialize-master-only") {
  await ensureGatewayKeyMaster();
} else if (action === "fail-write") {
  await ensureGatewayKeySchema(injectedFileOperations("writeFileSync"));
} else if (action === "fail-publish") {
  await ensureGatewayKeySchema(injectedFileOperations("linkSync"));
} else if (action === "fail-write-and-cleanup") {
  await ensureGatewayKeySchema(injectedFileOperations("writeFileSync", "unlinkSync"));
} else {
  await ensureGatewayKeySchema();
}

if (action === "reveal") {
  const key = (await listGatewayKeys("default"))[0];
  if (!key) throw new Error("No gateway key to reveal.");
  process.stdout.write(`${await revealGatewayKey("default", key.id)}\n`);
}
