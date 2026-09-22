import { createClient } from "@libsql/client";
import { env } from "./env";

export const db = createClient({
  url: env.databaseUrl,
  authToken: env.databaseAuthToken,
});

export async function checkDatabaseConnection(): Promise<void> {
  await db.execute("SELECT 1");
}
