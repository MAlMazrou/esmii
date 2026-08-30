import { readFile } from "node:fs/promises";
import { isIP } from "node:net";

export type AppEnvironment = "development" | "test" | "staging" | "production";
export type AuthProviderId = "google" | "microsoft" | "apple";
export type EnvironmentMap = Readonly<Record<string, string | undefined>>;

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret?: string;
  keyId?: string;
  privateKey?: string;
  teamId?: string;
}

export interface AuthProviderConfig {
  apple?: OAuthProviderConfig;
  google?: OAuthProviderConfig;
  microsoft?: OAuthProviderConfig;
  mockProviders: readonly "google"[];
}

export interface AuthenticationConfig {
  betterAuthSecret: string;
  providers: AuthProviderConfig;
  publicOrigin: string;
  recentAuthenticationSeconds: number;
  sessionLifetimeSeconds: number;
  stagingTesterEmails: ReadonlySet<string>;
}

export interface HttpServerConfig {
  appEnvironment: AppEnvironment;
  authentication: AuthenticationConfig;
  databaseUrl: string;
  host: string;
  operationsHealthToken: string;
  port: number;
  securityTombstoneMode: "capture" | "external";
  securityTombstoneJournal?: string;
  trustedProxyIp?: string;
  valkeyUrl: string;
}

export type ActionLinkPurpose = "magic-link" | "invitation";
export type ActionLinkKeyStatus = "active" | "overlap" | "retired";

export interface ActionLinkKey {
  key: Uint8Array;
  purpose: ActionLinkPurpose;
  status: ActionLinkKeyStatus;
  version: number;
}

export interface ActionLinkKeyring {
  environment: AppEnvironment;
  keys: readonly ActionLinkKey[];
  schemaVersion: 1;
}

export interface WorkerConfig {
  actionLinkKeyring: ActionLinkKeyring;
  appEnvironment: AppEnvironment;
  databaseUrl: string;
  heartbeatIntervalMs: number;
  jobConcurrency: number;
  pgBossCreateSchema: false;
  pgBossMigrate: false;
  publicOrigin: string;
  smtpUrl: string;
  valkeyUrl: string;
}

export interface MigrationConfig {
  appEnvironment: AppEnvironment;
  databaseUrl: string;
  migrationsDirectory?: string;
}

export class ConfigurationError extends Error {
  public readonly field: string;

  public constructor(field: string, reason: string) {
    super(`Invalid configuration for ${field}: ${reason}`);
    this.name = "ConfigurationError";
    this.field = field;
  }
}

export type SecretFileReader = (path: string) => Promise<string>;

function removeOneTrailingLineEnding(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

export async function readRuntimeValue(
  name: string,
  environment: EnvironmentMap,
  fileReader: SecretFileReader = (path) => readFile(path, "utf8"),
): Promise<string> {
  const directValue = environment[name];
  const fileVariableName = `${name}_FILE`;
  const filePath = environment[fileVariableName];

  if (directValue !== undefined && filePath !== undefined) {
    throw new ConfigurationError(name, `set either ${name} or ${fileVariableName}, not both`);
  }
  if (directValue === undefined && filePath === undefined) {
    throw new ConfigurationError(name, "required value is missing");
  }
  if (directValue !== undefined) {
    if (directValue.length === 0) throw new ConfigurationError(name, "value must not be empty");
    return directValue;
  }

  let fileValue: string;
  try {
    fileValue = await fileReader(filePath as string);
  } catch {
    throw new ConfigurationError(name, "secret file could not be read");
  }
  const value = removeOneTrailingLineEnding(fileValue);
  if (value.length === 0) throw new ConfigurationError(name, "secret file is empty");
  return value;
}

async function readOptionalRuntimeValue(
  name: string,
  environment: EnvironmentMap,
  fileReader: SecretFileReader,
): Promise<string | undefined> {
  if (environment[name] === undefined && environment[`${name}_FILE`] === undefined)
    return undefined;
  return readRuntimeValue(name, environment, fileReader);
}

function readAppEnvironment(environment: EnvironmentMap): AppEnvironment {
  const value = environment.APP_ENV ?? "development";
  if (
    value !== "development" &&
    value !== "test" &&
    value !== "staging" &&
    value !== "production"
  ) {
    throw new ConfigurationError("APP_ENV", "expected development, test, staging, or production");
  }
  return value;
}

function parseInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? String(defaultValue);
  if (!/^\d+$/.test(resolved)) throw new ConfigurationError(name, "expected an integer");
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError(name, `expected a value from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function parseFalse(name: string, value: string | undefined): false {
  if ((value ?? "false") !== "false") {
    throw new ConfigurationError(name, "must remain false in an application runtime");
  }
  return false;
}

function validateUrl(
  name: string,
  rawValue: string,
  protocols: ReadonlySet<string>,
  requireOriginOnly = false,
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new ConfigurationError(name, "expected a valid URL");
  }
  if (!protocols.has(parsed.protocol) || parsed.hostname.length === 0) {
    throw new ConfigurationError(name, "URL protocol or host is not allowed");
  }
  if (
    requireOriginOnly &&
    (parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.username)
  ) {
    throw new ConfigurationError(
      name,
      "expected an origin without path, query, fragment, or user info",
    );
  }
  return requireOriginOnly ? parsed.origin : rawValue;
}

function canonicalizeEmail(value: string): string {
  const canonical = value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
  if (
    canonical.length < 3 ||
    canonical.length > 320 ||
    canonical.includes(" ") ||
    !canonical.includes("@")
  ) {
    throw new ConfigurationError("AUTH_STAGING_TESTER_EMAILS", "contains an invalid email");
  }
  return canonical;
}

function parseStagingTesterEmails(rawValue: string | undefined): ReadonlySet<string> {
  if (rawValue === undefined || rawValue.trim().length === 0) return new Set<string>();
  return new Set(rawValue.split(",").map(canonicalizeEmail));
}

async function readDatabaseUrl(
  environment: EnvironmentMap,
  fileReader: SecretFileReader,
): Promise<string> {
  return validateUrl(
    "APP_DATABASE_URL",
    await readRuntimeValue("APP_DATABASE_URL", environment, fileReader),
    new Set(["postgres:", "postgresql:"]),
  );
}

async function readValkeyUrl(
  environment: EnvironmentMap,
  fileReader: SecretFileReader,
): Promise<string> {
  return validateUrl(
    "APP_VALKEY_URL",
    await readRuntimeValue("APP_VALKEY_URL", environment, fileReader),
    new Set(["redis:", "rediss:"]),
  );
}

function readPublicOrigin(environment: EnvironmentMap, appEnvironment: AppEnvironment): string {
  const fallback =
    appEnvironment === "development" || appEnvironment === "test"
      ? "http://localhost:8080"
      : undefined;
  const rawValue = environment.APP_PUBLIC_ORIGIN ?? fallback;
  if (rawValue === undefined) {
    throw new ConfigurationError("APP_PUBLIC_ORIGIN", "required value is missing");
  }
  const origin = validateUrl("APP_PUBLIC_ORIGIN", rawValue, new Set(["http:", "https:"]), true);
  if (
    (appEnvironment === "staging" || appEnvironment === "production") &&
    !origin.startsWith("https://")
  ) {
    throw new ConfigurationError(
      "APP_PUBLIC_ORIGIN",
      "HTTPS is required outside local development",
    );
  }
  return origin;
}

function assertSecretStrength(name: string, value: string, minimum = 32): void {
  if (value.length < minimum || value.length > 4096 || /\s/.test(value)) {
    throw new ConfigurationError(
      name,
      `value must contain ${minimum} to 4096 non-whitespace characters`,
    );
  }
}

async function readProviderConfiguration(
  environment: EnvironmentMap,
  fileReader: SecretFileReader,
  appEnvironment: AppEnvironment,
): Promise<AuthProviderConfig> {
  const googleId = await readOptionalRuntimeValue("AUTH_GOOGLE_CLIENT_ID", environment, fileReader);
  const googleSecret = await readOptionalRuntimeValue(
    "AUTH_GOOGLE_CLIENT_SECRET",
    environment,
    fileReader,
  );
  const microsoftId = await readOptionalRuntimeValue(
    "AUTH_MICROSOFT_CLIENT_ID",
    environment,
    fileReader,
  );
  const microsoftSecret = await readOptionalRuntimeValue(
    "AUTH_MICROSOFT_CLIENT_SECRET",
    environment,
    fileReader,
  );
  const appleId = await readOptionalRuntimeValue("AUTH_APPLE_CLIENT_ID", environment, fileReader);
  const appleTeamId = await readOptionalRuntimeValue("AUTH_APPLE_TEAM_ID", environment, fileReader);
  const appleKeyId = await readOptionalRuntimeValue("AUTH_APPLE_KEY_ID", environment, fileReader);
  const applePrivateKey = await readOptionalRuntimeValue(
    "AUTH_APPLE_PRIVATE_KEY",
    environment,
    fileReader,
  );

  if ((googleId === undefined) !== (googleSecret === undefined)) {
    throw new ConfigurationError(
      "AUTH_GOOGLE_CLIENT_ID",
      "Google client ID and secret must be configured together",
    );
  }
  if ((microsoftId === undefined) !== (microsoftSecret === undefined)) {
    throw new ConfigurationError(
      "AUTH_MICROSOFT_CLIENT_ID",
      "Microsoft client ID and secret must be configured together",
    );
  }
  const appleValues = [appleId, appleTeamId, appleKeyId, applePrivateKey];
  if (
    appleValues.some((value) => value !== undefined) &&
    appleValues.some((value) => value === undefined)
  ) {
    throw new ConfigurationError(
      "AUTH_APPLE_CLIENT_ID",
      "all Apple identity fields must be configured together",
    );
  }
  if (appEnvironment === "development" && appleId !== undefined) {
    throw new ConfigurationError(
      "AUTH_APPLE_CLIENT_ID",
      "Apple remains disabled in local development",
    );
  }

  const mockEnabled = environment.AUTH_MOCK_PROVIDERS === "true";
  if (mockEnabled && appEnvironment !== "development" && appEnvironment !== "test") {
    throw new ConfigurationError("AUTH_MOCK_PROVIDERS", "mock providers are local/test only");
  }
  const mockProviders: "google"[] = [];
  if (mockEnabled && googleId === undefined) mockProviders.push("google");

  return {
    ...(googleId === undefined
      ? {}
      : { google: { clientId: googleId, clientSecret: googleSecret as string } }),
    ...(microsoftId === undefined
      ? {}
      : { microsoft: { clientId: microsoftId, clientSecret: microsoftSecret as string } }),
    ...(appleId === undefined
      ? {}
      : {
          apple: {
            clientId: appleId,
            teamId: appleTeamId as string,
            keyId: appleKeyId as string,
            privateKey: applePrivateKey as string,
          },
        }),
    mockProviders,
  };
}

interface SerializedActionLinkKey {
  key: string;
  purpose: ActionLinkPurpose;
  status: ActionLinkKeyStatus;
  version: number;
}

interface SerializedActionLinkKeyring {
  environment: AppEnvironment;
  keys: SerializedActionLinkKey[];
  schemaVersion: number;
}

function decodeBase64UrlKey(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43,}$/.test(value)) {
    throw new ConfigurationError("ACTION_LINK_DERIVATION_KEYRING", "contains invalid key material");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength < 32) {
    throw new ConfigurationError(
      "ACTION_LINK_DERIVATION_KEYRING",
      "keys must contain at least 256 bits",
    );
  }
  return new Uint8Array(decoded);
}

function parseActionLinkKeyring(
  rawValue: string,
  appEnvironment: AppEnvironment,
): ActionLinkKeyring {
  let parsed: SerializedActionLinkKeyring;
  try {
    parsed = JSON.parse(rawValue) as SerializedActionLinkKeyring;
  } catch {
    throw new ConfigurationError("ACTION_LINK_DERIVATION_KEYRING", "expected valid JSON");
  }
  if (
    parsed.schemaVersion !== 1 ||
    parsed.environment !== appEnvironment ||
    !Array.isArray(parsed.keys)
  ) {
    throw new ConfigurationError(
      "ACTION_LINK_DERIVATION_KEYRING",
      "schema version or environment does not match this worker",
    );
  }
  const seen = new Set<string>();
  const activeByPurpose = new Map<ActionLinkPurpose, number>();
  const keys = parsed.keys.map((item): ActionLinkKey => {
    if (
      (item.purpose !== "magic-link" && item.purpose !== "invitation") ||
      (item.status !== "active" && item.status !== "overlap" && item.status !== "retired") ||
      !Number.isSafeInteger(item.version) ||
      item.version < 1
    ) {
      throw new ConfigurationError(
        "ACTION_LINK_DERIVATION_KEYRING",
        "contains an invalid key entry",
      );
    }
    const identity = `${item.purpose}:${item.version}`;
    if (seen.has(identity)) {
      throw new ConfigurationError(
        "ACTION_LINK_DERIVATION_KEYRING",
        "contains duplicate purpose/version entries",
      );
    }
    seen.add(identity);
    if (item.status === "active") {
      activeByPurpose.set(item.purpose, (activeByPurpose.get(item.purpose) ?? 0) + 1);
    }
    return { ...item, key: decodeBase64UrlKey(item.key) };
  });
  for (const purpose of ["magic-link", "invitation"] as const) {
    if (activeByPurpose.get(purpose) !== 1) {
      throw new ConfigurationError(
        "ACTION_LINK_DERIVATION_KEYRING",
        `requires exactly one active ${purpose} key`,
      );
    }
  }
  return { environment: appEnvironment, keys, schemaVersion: 1 };
}

export async function loadHttpServerConfig(
  environment: EnvironmentMap = process.env,
  fileReader?: SecretFileReader,
): Promise<HttpServerConfig> {
  const effectiveReader = fileReader ?? ((path: string) => readFile(path, "utf8"));
  const appEnvironment = readAppEnvironment(environment);
  const [databaseUrl, valkeyUrl, operationsHealthToken, betterAuthSecret, providers, journal] =
    await Promise.all([
      readDatabaseUrl(environment, effectiveReader),
      readValkeyUrl(environment, effectiveReader),
      readRuntimeValue("OPERATIONS_HEALTH_TOKEN", environment, effectiveReader),
      readRuntimeValue("BETTER_AUTH_SECRET", environment, effectiveReader),
      readProviderConfiguration(environment, effectiveReader, appEnvironment),
      readOptionalRuntimeValue("SECURITY_TOMBSTONE_JOURNAL", environment, effectiveReader),
    ]);
  assertSecretStrength("OPERATIONS_HEALTH_TOKEN", operationsHealthToken);
  assertSecretStrength("BETTER_AUTH_SECRET", betterAuthSecret);

  const trustedProxyIp = environment.TRUSTED_PROXY_IP;
  if (trustedProxyIp !== undefined && isIP(trustedProxyIp) === 0) {
    throw new ConfigurationError("TRUSTED_PROXY_IP", "expected one exact IPv4 or IPv6 address");
  }
  const host = environment.HOST ?? "0.0.0.0";
  if (host.trim().length === 0) throw new ConfigurationError("HOST", "value must not be empty");
  const securityTombstoneMode = environment.SECURITY_TOMBSTONE_MODE ?? "capture";
  if (securityTombstoneMode !== "capture" && securityTombstoneMode !== "external") {
    throw new ConfigurationError("SECURITY_TOMBSTONE_MODE", "expected capture or external");
  }
  if (securityTombstoneMode === "external" && journal === undefined) {
    throw new ConfigurationError("SECURITY_TOMBSTONE_JOURNAL", "required in external mode");
  }
  if (
    (appEnvironment === "development" || appEnvironment === "test") &&
    securityTombstoneMode !== "capture"
  ) {
    throw new ConfigurationError(
      "SECURITY_TOMBSTONE_MODE",
      "local/test environments must use capture mode",
    );
  }

  const stagingTesterEmails = parseStagingTesterEmails(environment.AUTH_STAGING_TESTER_EMAILS);
  if (appEnvironment === "staging" && stagingTesterEmails.size === 0) {
    throw new ConfigurationError(
      "AUTH_STAGING_TESTER_EMAILS",
      "staging requires a non-empty allowlist",
    );
  }

  return {
    appEnvironment,
    authentication: {
      betterAuthSecret,
      providers,
      publicOrigin: readPublicOrigin(environment, appEnvironment),
      recentAuthenticationSeconds: parseInteger(
        "AUTH_RECENT_SECONDS",
        environment.AUTH_RECENT_SECONDS,
        600,
        60,
        3600,
      ),
      sessionLifetimeSeconds: parseInteger(
        "AUTH_SESSION_LIFETIME_SECONDS",
        environment.AUTH_SESSION_LIFETIME_SECONDS,
        2_592_000,
        3600,
        7_776_000,
      ),
      stagingTesterEmails,
    },
    databaseUrl,
    host,
    operationsHealthToken,
    port: parseInteger("PORT", environment.PORT, 3000, 1, 65_535),
    securityTombstoneMode,
    ...(journal === undefined ? {} : { securityTombstoneJournal: journal }),
    ...(trustedProxyIp === undefined ? {} : { trustedProxyIp }),
    valkeyUrl,
  };
}

export async function loadWorkerConfig(
  environment: EnvironmentMap = process.env,
  fileReader?: SecretFileReader,
): Promise<WorkerConfig> {
  const effectiveReader = fileReader ?? ((path: string) => readFile(path, "utf8"));
  const appEnvironment = readAppEnvironment(environment);
  const [databaseUrl, valkeyUrl, smtpUrl, serializedKeyring] = await Promise.all([
    readDatabaseUrl(environment, effectiveReader),
    readValkeyUrl(environment, effectiveReader),
    readRuntimeValue("SMTP_URL", environment, effectiveReader),
    readRuntimeValue("ACTION_LINK_DERIVATION_KEYRING", environment, effectiveReader),
  ]);
  return {
    actionLinkKeyring: parseActionLinkKeyring(serializedKeyring, appEnvironment),
    appEnvironment,
    databaseUrl,
    heartbeatIntervalMs: parseInteger(
      "WORKER_HEARTBEAT_INTERVAL_MS",
      environment.WORKER_HEARTBEAT_INTERVAL_MS,
      30_000,
      1_000,
      300_000,
    ),
    jobConcurrency: parseInteger("JOB_CONCURRENCY", environment.JOB_CONCURRENCY, 1, 1, 32),
    pgBossCreateSchema: parseFalse("PGBOSS_CREATE_SCHEMA", environment.PGBOSS_CREATE_SCHEMA),
    pgBossMigrate: parseFalse("PGBOSS_MIGRATE", environment.PGBOSS_MIGRATE),
    publicOrigin: readPublicOrigin(environment, appEnvironment),
    smtpUrl: validateUrl("SMTP_URL", smtpUrl, new Set(["smtp:", "smtps:"])),
    valkeyUrl,
  };
}

export async function loadMigrationConfig(
  environment: EnvironmentMap = process.env,
  fileReader?: SecretFileReader,
): Promise<MigrationConfig> {
  const effectiveReader = fileReader ?? ((path: string) => readFile(path, "utf8"));
  const base = {
    appEnvironment: readAppEnvironment(environment),
    databaseUrl: await readDatabaseUrl(environment, effectiveReader),
  } satisfies Omit<MigrationConfig, "migrationsDirectory">;
  const migrationsDirectory = environment.DATABASE_MIGRATIONS_DIR;
  if (migrationsDirectory !== undefined && migrationsDirectory.trim().length === 0) {
    throw new ConfigurationError("DATABASE_MIGRATIONS_DIR", "value must not be empty");
  }
  return migrationsDirectory === undefined ? base : { ...base, migrationsDirectory };
}

export function getActionLinkKey(
  keyring: ActionLinkKeyring,
  purpose: ActionLinkPurpose,
  version?: number,
): ActionLinkKey {
  const key = keyring.keys.find(
    (candidate) =>
      candidate.purpose === purpose &&
      (version === undefined ? candidate.status === "active" : candidate.version === version),
  );
  if (key === undefined || key.status === "retired") {
    throw new ConfigurationError(
      "ACTION_LINK_DERIVATION_KEYRING",
      "requested key is unavailable or retired",
    );
  }
  return key;
}
