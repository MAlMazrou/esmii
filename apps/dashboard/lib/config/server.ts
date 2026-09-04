import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

type MonitoringEnvironment = "production" | "staging";

export interface PublicDashboardConfig {
  readonly environment: MonitoringEnvironment;
  readonly origin: string;
  readonly peerOrigin: string;
  readonly themeFixture: "contract-test" | null;
}

export interface DashboardAuthConfig extends PublicDashboardConfig {
  readonly databaseFile: string;
  readonly emailOtpCaptureFile: string | null;
  readonly emailOtpFrom: string;
  readonly secret: string;
  readonly smtpUrl: string | null;
}

export interface MonitoringServerConfig extends PublicDashboardConfig {
  readonly fixtureMode: boolean;
  readonly logFile: string | null;
  readonly logMaxBytes: number;
  readonly prometheusTimeoutMs: number;
  readonly prometheusUrl: string | null;
}

type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function requireString(env: EnvironmentRecord, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty configuration value`);
  }
  if (containsControlCharacter(value)) {
    throw new TypeError(`${name} contains an invalid control character`);
  }
  return value;
}

function optionalString(env: EnvironmentRecord, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value === "") return undefined;
  return requireString(env, name);
}

function parseEnvironment(value: string): MonitoringEnvironment {
  if (value !== "production" && value !== "staging") {
    throw new TypeError("DASHBOARD_ENVIRONMENT must be production or staging");
  }
  return value;
}

function normalizeOrigin(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${name} must be an absolute URL`);
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError(`${name} must contain only a scheme and host`);
  }
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new TypeError(`${name} must use HTTPS outside loopback development`);
  }
  return parsed.origin;
}

function parseBoolean(env: EnvironmentRecord, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be true or false`);
}

function parseInteger(
  env: EnvironmentRecord,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function requireAbsolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return value;
}

function parsePrivateHttpUrl(
  value: string,
  environment: MonitoringEnvironment,
  fixtureMode: boolean,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("DASHBOARD_PROMETHEUS_URL must be an absolute URL");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("DASHBOARD_PROMETHEUS_URL must be a credential-free HTTP URL");
  }
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "localhost";
  const requiredHost = environment === "staging" ? "staging-prometheus" : "production-prometheus";
  if ((fixtureMode && !loopback) || (!fixtureMode && parsed.hostname !== requiredHost)) {
    throw new TypeError(
      `DASHBOARD_PROMETHEUS_URL must use the private ${requiredHost} service for this environment`,
    );
  }
  if (!fixtureMode && parsed.port !== "9090") {
    throw new TypeError("DASHBOARD_PROMETHEUS_URL must use the internal Prometheus port 9090");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/$/u, "");
}

function readSecret(
  env: EnvironmentRecord,
  directName: string,
  fileName: string,
  readFile: (path: string, encoding: BufferEncoding) => string,
): string {
  const direct = optionalString(env, directName);
  const file = optionalString(env, fileName);
  if (direct !== undefined && file !== undefined) {
    throw new TypeError(`${directName} and ${fileName} cannot both be set`);
  }
  if (direct === undefined && file === undefined) {
    throw new TypeError(`${fileName} is required`);
  }
  const value =
    file === undefined
      ? direct
      : readFile(requireAbsolutePath(file, fileName), "utf8").replace(/\r?\n$/u, "");
  if (value === undefined || value.length < 32 || /\s/u.test(value)) {
    throw new TypeError("The dashboard authentication secret is invalid");
  }
  return value;
}

function parseDashboardSmtpUrl(value: string, expectedEmail: string): string {
  let parsed: URL;
  let username: string;
  let password: string;
  try {
    parsed = new URL(value);
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    throw new TypeError("DASHBOARD_SMTP_URL_FILE must contain an absolute SMTP URL");
  }
  if (
    parsed.protocol !== "smtp:" ||
    parsed.hostname !== "mail.esmii.app" ||
    parsed.port !== "587" ||
    username !== expectedEmail ||
    password.length < 32 ||
    password.length > 512 ||
    [...password].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 33 || code > 126;
    }) ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.hash !== "" ||
    parsed.searchParams.size !== 1 ||
    parsed.searchParams.get("requireTLS") !== "true"
  ) {
    throw new TypeError(
      "DASHBOARD_SMTP_URL_FILE must use authenticated STARTTLS submission to mail.esmii.app:587",
    );
  }
  return value;
}

export function parsePublicDashboardConfig(
  env: EnvironmentRecord = process.env,
): PublicDashboardConfig {
  const environment = parseEnvironment(requireString(env, "DASHBOARD_ENVIRONMENT"));
  const origin = normalizeOrigin(requireString(env, "DASHBOARD_ORIGIN"), "DASHBOARD_ORIGIN");
  const peerOrigin = normalizeOrigin(
    requireString(env, "DASHBOARD_PEER_ORIGIN"),
    "DASHBOARD_PEER_ORIGIN",
  );
  if (peerOrigin === origin) {
    throw new TypeError("DASHBOARD_PEER_ORIGIN must identify the other environment");
  }
  if (env.NODE_ENV === "production" && env.MONITORING_FIXTURE_MODE !== "true") {
    const expectedOrigin =
      environment === "staging"
        ? "https://staging-dashboard.esmii.app"
        : "https://dashboard.esmii.app";
    const expectedPeer =
      environment === "staging"
        ? "https://dashboard.esmii.app"
        : "https://staging-dashboard.esmii.app";
    if (origin !== expectedOrigin || peerOrigin !== expectedPeer) {
      throw new TypeError(
        "Production dashboard origins must match the fixed environment hostnames",
      );
    }
  }
  const rawThemeFixture = optionalString(env, "DASHBOARD_THEME_FIXTURE");
  const originUrl = new URL(origin);
  const loopback =
    originUrl.hostname === "127.0.0.1" ||
    originUrl.hostname === "[::1]" ||
    originUrl.hostname === "localhost";
  if (rawThemeFixture !== undefined && (rawThemeFixture !== "contract-test" || !loopback)) {
    throw new TypeError("DASHBOARD_THEME_FIXTURE supports only contract-test on a loopback origin");
  }
  return {
    environment,
    origin,
    peerOrigin,
    themeFixture: rawThemeFixture === "contract-test" ? rawThemeFixture : null,
  };
}

export function parseDashboardAuthConfig(
  env: EnvironmentRecord = process.env,
  readFile: (path: string, encoding: BufferEncoding) => string = readFileSync,
): DashboardAuthConfig {
  const publicConfig = parsePublicDashboardConfig(env);
  const fixtureMode = parseBoolean(env, "MONITORING_FIXTURE_MODE", false);
  const captureFile = optionalString(env, "DASHBOARD_EMAIL_OTP_CAPTURE_FILE");
  const directSmtpUrl = optionalString(env, "DASHBOARD_SMTP_URL");
  const smtpUrlFile = optionalString(env, "DASHBOARD_SMTP_URL_FILE");
  if (env.NODE_ENV === "production") {
    if (optionalString(env, "DASHBOARD_AUTH_SECRET") !== undefined) {
      throw new TypeError(
        "Production must load DASHBOARD_AUTH_SECRET_FILE instead of a direct value",
      );
    }
    if (directSmtpUrl !== undefined) {
      throw new TypeError("Production must load DASHBOARD_SMTP_URL_FILE instead of a direct value");
    }
  }
  if (directSmtpUrl !== undefined && smtpUrlFile !== undefined) {
    throw new TypeError("DASHBOARD_SMTP_URL and DASHBOARD_SMTP_URL_FILE cannot both be set");
  }
  if (captureFile !== undefined) {
    const origin = new URL(publicConfig.origin);
    const loopback =
      origin.hostname === "127.0.0.1" ||
      origin.hostname === "[::1]" ||
      origin.hostname === "localhost";
    if (!fixtureMode || !loopback) {
      throw new TypeError("DASHBOARD_EMAIL_OTP_CAPTURE_FILE is allowed only for loopback fixtures");
    }
    if (directSmtpUrl !== undefined || smtpUrlFile !== undefined) {
      throw new TypeError("Email OTP capture and SMTP delivery cannot both be configured");
    }
  } else if (directSmtpUrl === undefined && smtpUrlFile === undefined) {
    throw new TypeError("DASHBOARD_SMTP_URL_FILE is required outside an email OTP fixture");
  }
  const rawSmtpUrl =
    directSmtpUrl ??
    (smtpUrlFile === undefined
      ? null
      : readFile(requireAbsolutePath(smtpUrlFile, "DASHBOARD_SMTP_URL_FILE"), "utf8").replace(
          /\r?\n$/u,
          "",
        ));
  const emailOtpFrom =
    publicConfig.environment === "staging"
      ? "monitoring-staging@esmii.app"
      : "monitoring@esmii.app";
  return {
    ...publicConfig,
    databaseFile: requireAbsolutePath(
      requireString(env, "DASHBOARD_AUTH_DATABASE_FILE"),
      "DASHBOARD_AUTH_DATABASE_FILE",
    ),
    emailOtpCaptureFile:
      captureFile === undefined
        ? null
        : requireAbsolutePath(captureFile, "DASHBOARD_EMAIL_OTP_CAPTURE_FILE"),
    emailOtpFrom,
    secret: readSecret(env, "DASHBOARD_AUTH_SECRET", "DASHBOARD_AUTH_SECRET_FILE", readFile),
    smtpUrl: rawSmtpUrl === null ? null : parseDashboardSmtpUrl(rawSmtpUrl, emailOtpFrom),
  };
}

export function parseMonitoringServerConfig(
  env: EnvironmentRecord = process.env,
): MonitoringServerConfig {
  const publicConfig = parsePublicDashboardConfig(env);
  const fixtureMode = parseBoolean(env, "MONITORING_FIXTURE_MODE", false);
  const origin = new URL(publicConfig.origin);
  const loopbackFixture =
    origin.hostname === "127.0.0.1" ||
    origin.hostname === "[::1]" ||
    origin.hostname === "localhost";
  if (fixtureMode && !loopbackFixture) {
    throw new TypeError("MONITORING_FIXTURE_MODE is allowed only on a loopback origin");
  }

  const prometheus = optionalString(env, "DASHBOARD_PROMETHEUS_URL");
  const logFile = optionalString(env, "DASHBOARD_LOG_FILE");
  if (!fixtureMode && prometheus === undefined) {
    throw new TypeError("DASHBOARD_PROMETHEUS_URL is required outside fixture mode");
  }
  if (!fixtureMode && logFile === undefined) {
    throw new TypeError("DASHBOARD_LOG_FILE is required outside fixture mode");
  }

  return {
    ...publicConfig,
    fixtureMode,
    logFile: logFile === undefined ? null : requireAbsolutePath(logFile, "DASHBOARD_LOG_FILE"),
    logMaxBytes: parseInteger(env, "DASHBOARD_LOG_MAX_BYTES", 1_048_576, 65_536, 20_971_520),
    prometheusTimeoutMs: parseInteger(env, "DASHBOARD_PROMETHEUS_TIMEOUT_MS", 4_500, 500, 10_000),
    prometheusUrl:
      prometheus === undefined
        ? null
        : parsePrivateHttpUrl(prometheus, publicConfig.environment, fixtureMode),
  };
}
