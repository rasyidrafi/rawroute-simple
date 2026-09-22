function requireEnv(name: string, value: string | undefined): string {
  const normalizedValue = value?.trim();

  if (!normalizedValue) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and set it before starting the server.`,
    );
  }

  return normalizedValue;
}

function optionalOrigin(value: string | undefined): string | undefined {
  const normalizedValue = value?.trim();
  if (!normalizedValue) return undefined;

  let origin: URL;
  try {
    origin = new URL(normalizedValue);
  } catch {
    throw new Error(`APP_ORIGIN must be a valid http:// or https:// URL. Received: ${normalizedValue}`);
  }

  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error(
      `APP_ORIGIN must contain only the scheme and origin, without a path or query string. Received: ${normalizedValue}`,
    );
  }

  return origin.origin;
}

function optionalBoolean(name: string, value: string | undefined, defaultValue: boolean): boolean {
  const normalizedValue = value?.trim().toLowerCase();
  if (!normalizedValue) return defaultValue;
  if (normalizedValue === "true") return true;
  if (normalizedValue === "false") return false;

  throw new Error(`${name} must be either true or false. Received: ${value}`);
}

const portValue = Bun.env.PORT?.trim() ?? "3001";
const port = Number(portValue);
const nodeEnv = Bun.env.NODE_ENV?.trim().toLowerCase() ?? "development";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT must be an integer between 1 and 65535. Received: ${portValue}`);
}

const configuredDatabaseUrl = Bun.env.DATABASE_URL?.trim();
const databaseUrl =
  configuredDatabaseUrl ??
  (nodeEnv === "production" ? requireEnv("DATABASE_URL", configuredDatabaseUrl) : "file:./dev.db");
const databaseAuthToken = Bun.env.DATABASE_AUTH_TOKEN?.trim();
const authDefaultPassword = requireEnv("AUTH_DEFAULT_PASSWORD", Bun.env.AUTH_DEFAULT_PASSWORD);
const appOrigin = optionalOrigin(Bun.env.APP_ORIGIN);
const secureCookies = optionalBoolean(
  "AUTH_COOKIE_SECURE",
  Bun.env.AUTH_COOKIE_SECURE,
  appOrigin?.startsWith("https://") ?? false,
);
const trustProxyHeaders = optionalBoolean(
  "TRUST_PROXY_HEADERS",
  Bun.env.TRUST_PROXY_HEADERS,
  false,
);

if (nodeEnv === "production" && !appOrigin) {
  throw new Error("APP_ORIGIN is required when NODE_ENV=production.");
}

if (appOrigin?.startsWith("http://") && secureCookies) {
  throw new Error("AUTH_COOKIE_SECURE=true requires an HTTPS APP_ORIGIN.");
}

if (nodeEnv === "production" && appOrigin?.startsWith("https://") && !secureCookies) {
  throw new Error("AUTH_COOKIE_SECURE must be true for an HTTPS production APP_ORIGIN.");
}

if (databaseUrl.startsWith("libsql://") && !databaseAuthToken) {
  throw new Error(
    "DATABASE_AUTH_TOKEN is required for a Turso Cloud libsql:// connection.",
  );
}

export const env = {
  port,
  nodeEnv,
  databaseUrl,
  databaseAuthToken,
  authDefaultPassword,
  appOrigin,
  secureCookies,
  trustProxyHeaders,
} as const;
