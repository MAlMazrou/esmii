import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "..");

const preOneVersionPattern = /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export function assertPreOneVersion(version) {
  if (typeof version !== "string" || !preOneVersionPattern.test(version)) {
    throw new Error(
      `Esmii requires a stable pre-1.0 semantic version; received ${JSON.stringify(version)}.`,
    );
  }
  return version;
}

export function readRawAppVersion(root = repositoryRoot) {
  const packagePath = resolve(root, "package.json");
  const packageDocument = JSON.parse(readFileSync(packagePath, "utf8"));
  return assertPreOneVersion(packageDocument.version);
}

export function readPublicAppVersion(root = repositoryRoot) {
  return `v${readRawAppVersion(root)}`;
}

export function withAppVersionEnvironment(environment = process.env, root = repositoryRoot) {
  const version = readPublicAppVersion(root);
  for (const name of ["ESMII_APP_VERSION", "NEXT_PUBLIC_APP_VERSION"]) {
    const configured = environment[name];
    if (configured !== undefined && configured !== version) {
      throw new Error(`${name}=${configured} does not match package.json ${version}.`);
    }
  }
  return {
    ...environment,
    ESMII_APP_VERSION: version,
    NEXT_PUBLIC_APP_VERSION: version,
  };
}

function runCommand() {
  const command = process.argv[2] ?? "print";
  const version = readPublicAppVersion();

  if (command === "print") {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (command === "raw") {
    process.stdout.write(`${version.slice(1)}\n`);
    return;
  }
  if (command === "verify") {
    process.stdout.write(`Verified Esmii application version ${version}.\n`);
    return;
  }

  throw new Error("Usage: app-version.mjs [print|raw|verify]");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    runCommand();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
