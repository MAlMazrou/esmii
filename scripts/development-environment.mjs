import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalDockerInvocation,
  formatLocalDockerCommand,
  spawnLocalDocker,
} from "./local-docker.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localBase = join(root, ".local");
const localRoot = join(root, ".local", "development");
const secretsRoot = join(localRoot, "secrets");
const runtimeSecretsRoot = join(secretsRoot, "runtime");
const envPath = join(root, "infra", ".env.development.local");
const expectedProject = "esmii-development";

const secretFiles = [
  "postgres-superuser-password",
  "postgres-migration-password",
  "postgres-api-password",
  "postgres-worker-password",
  "valkey-api-password",
  "valkey-worker-password",
  "valkey-health-password",
  "operations-token",
  "better-auth-secret",
];

const composeSecretFiles = [
  "postgres-superuser-password",
  "postgres-migration-password",
  "postgres-api-password",
  "postgres-worker-password",
  "database-migration-url",
  "database-api-url",
  "database-worker-url",
  "valkey-users.acl",
  "valkey-health-password",
  "valkey-api-url",
  "valkey-worker-url",
  "operations-token",
  "better-auth-secret",
  "action-link-derivation-keyring",
];

function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertOwnedPath(path, information, expectedType) {
  const matchesType =
    expectedType === "directory" ? information.isDirectory() : information.isFile();
  if (information.isSymbolicLink() || !matchesType) {
    throw new Error(`Refusing unsafe development path: ${path}`);
  }

  if (typeof process.getuid === "function" && information.uid !== process.getuid()) {
    throw new Error(`Refusing development path not owned by the current user: ${path}`);
  }
}

async function ensurePrivateDirectory(path) {
  try {
    const information = await lstat(path);
    assertOwnedPath(path, information, "directory");
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(path, { mode: 0o700 });
    const information = await lstat(path);
    assertOwnedPath(path, information, "directory");
  }
  await chmod(path, 0o700);
}

async function validatePrivateFile(path) {
  const information = await lstat(path);
  assertOwnedPath(path, information, "file");
  await chmod(path, 0o600);
}

async function writeIfMissing(path, contents, mode = 0o600) {
  try {
    await validatePrivateFile(path);
    if ((await readFile(path, "utf8")).trim().length === 0) {
      throw new Error(`Refusing empty development file: ${path}`);
    }
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
    await writeFile(path, contents, { encoding: "utf8", mode, flag: "wx" });
  }
  await validatePrivateFile(path);
}

async function writePrivate(path, contents) {
  try {
    await validatePrivateFile(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
    await validatePrivateFile(path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function writeRuntimeCopy(filename) {
  const source = join(secretsRoot, filename);
  const destination = join(runtimeSecretsRoot, filename);
  await validatePrivateFile(source);
  const contents = await readFile(source);
  if (contents.length === 0) {
    throw new Error(`Refusing empty development secret file: ${source}`);
  }

  try {
    const information = await lstat(destination);
    assertOwnedPath(destination, information, "file");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const temporaryPath = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o400, flag: "wx" });
    await chmod(temporaryPath, 0o444);
    await rename(temporaryPath, destination);
    const information = await lstat(destination);
    assertOwnedPath(destination, information, "file");
    await chmod(destination, 0o444);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readSecret(filename) {
  const path = join(secretsRoot, filename);
  await validatePrivateFile(path);
  const value = (await readFile(path, "utf8")).trim();
  if (value.length < 32 || /\s/u.test(value)) {
    throw new Error(`Refusing invalid development secret file: ${path}`);
  }
  return value;
}

async function prepare() {
  await ensurePrivateDirectory(localBase);
  await ensurePrivateDirectory(localRoot);
  await ensurePrivateDirectory(secretsRoot);
  await ensurePrivateDirectory(runtimeSecretsRoot);

  for (const filename of secretFiles) {
    await writeIfMissing(join(secretsRoot, filename), `${randomBytes(32).toString("base64url")}\n`);
  }

  await writeIfMissing(
    join(secretsRoot, "action-link-derivation-keyring"),
    `${JSON.stringify({
      environment: "development",
      keys: [
        {
          key: randomBytes(32).toString("base64url"),
          purpose: "magic-link",
          status: "active",
          version: 1,
        },
        {
          key: randomBytes(32).toString("base64url"),
          purpose: "invitation",
          status: "active",
          version: 1,
        },
      ],
      schemaVersion: 1,
    })}\n`,
  );

  const postgresMigrationPassword = await readSecret("postgres-migration-password");
  const postgresApiPassword = await readSecret("postgres-api-password");
  const postgresWorkerPassword = await readSecret("postgres-worker-password");
  const valkeyApiPassword = await readSecret("valkey-api-password");
  const valkeyWorkerPassword = await readSecret("valkey-worker-password");
  const valkeyHealthPassword = await readSecret("valkey-health-password");

  await writePrivate(
    join(secretsRoot, "database-migration-url"),
    `postgresql://app_owner:${encodeURIComponent(postgresMigrationPassword)}@development-postgres:5432/esmii\n`,
  );
  await writePrivate(
    join(secretsRoot, "database-api-url"),
    `postgresql://app_api:${encodeURIComponent(postgresApiPassword)}@development-postgres:5432/esmii\n`,
  );
  await writePrivate(
    join(secretsRoot, "database-worker-url"),
    `postgresql://app_worker:${encodeURIComponent(postgresWorkerPassword)}@development-postgres:5432/esmii\n`,
  );
  await writePrivate(
    join(secretsRoot, "valkey-api-url"),
    `redis://esmii_api:${encodeURIComponent(valkeyApiPassword)}@development-valkey:6379/0\n`,
  );
  await writePrivate(
    join(secretsRoot, "valkey-worker-url"),
    `redis://esmii_worker:${encodeURIComponent(valkeyWorkerPassword)}@development-valkey:6379/0\n`,
  );
  await writePrivate(
    join(secretsRoot, "valkey-users.acl"),
    [
      "user default off",
      `user health on >${valkeyHealthPassword} ~* +ping`,
      `user esmii_api on >${valkeyApiPassword} ~esmii:api:* +@read +@write +ping -@dangerous +eval`,
      `user esmii_worker on >${valkeyWorkerPassword} ~esmii:* +@read +@write +ping -@dangerous`,
      "",
    ].join("\n"),
  );

  for (const filename of composeSecretFiles) {
    await writeRuntimeCopy(filename);
  }

  await writeIfMissing(
    envPath,
    [
      `COMPOSE_PROJECT_NAME=${expectedProject}`,
      "ESMII_DEVELOPMENT_EDGE_PORT=8080",
      "ESMII_DEVELOPMENT_MAILPIT_PORT=8025",
      "",
    ].join("\n"),
  );

  console.log("Prepared ignored development configuration without printing credentials.");
}

function composeDownWithVolumes() {
  const docker = createLocalDockerInvocation();
  const arguments_ = [
    "compose",
    "--project-name",
    expectedProject,
    "--env-file",
    envPath,
    "-f",
    join(root, "infra", "compose.yaml"),
    "-f",
    join(root, "infra", "compose.development.yaml"),
    "down",
    "--volumes",
    "--remove-orphans",
  ];
  console.log(`Local Docker command: ${formatLocalDockerCommand(docker, arguments_)}`);
  const result = spawnLocalDocker(docker, arguments_, { cwd: root, stdio: "inherit" });

  if (result.status !== 0) {
    throw new Error("Development Compose teardown failed; local files were not removed.");
  }
}

async function reset() {
  if (expectedProject !== "esmii-development" || !localRoot.startsWith(`${root}/.local/`)) {
    throw new Error("Refusing reset because the development target could not be proven.");
  }

  composeDownWithVolumes();
  await rm(localRoot, { recursive: true, force: true });
  await rm(envPath, { force: true });
  console.log("Removed only Esmii disposable local development state.");
}

const command = process.argv[2];

if (command === "prepare") {
  await prepare();
} else if (command === "reset") {
  await reset();
} else {
  console.error("Usage: development-environment.mjs <prepare|reset>");
  process.exit(1);
}
