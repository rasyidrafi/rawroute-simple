function requireEnv(name: string, value: string | undefined): string {
  const normalizedValue = value?.trim();

  if (!normalizedValue) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and set it before starting the server.`,
    );
  }

  return normalizedValue;
}

const portValue = Bun.env.PORT?.trim() ?? "3001";
const port = Number(portValue);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT must be an integer between 1 and 65535. Received: ${portValue}`);
}

const databaseUrl = requireEnv("DATABASE_URL", Bun.env.DATABASE_URL);
const databaseAuthToken = Bun.env.DATABASE_AUTH_TOKEN?.trim();

if (databaseUrl.startsWith("libsql://") && !databaseAuthToken) {
  throw new Error(
    "DATABASE_AUTH_TOKEN is required for a Turso Cloud libsql:// connection.",
  );
}

export const env = {
  port,
  databaseUrl,
  databaseAuthToken,
} as const;
