import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  renderActivationManifest,
  repositoryRoot,
  sha256,
  validateActivationManifest,
} from "./infra/core.mjs";
import { inspectTar } from "./infra/payload.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const sourceShaPattern = /^[0-9a-f]{40}$/u;

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys differ from the initial-staging contract.`);
  }
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function inside(root, path, label) {
  const result = relative(root, path);
  if (
    !result ||
    result === ".." ||
    result.startsWith(`..${sep}`) ||
    resolve(root, result) !== path
  ) {
    throw new Error(`${label} must resolve below its approved artifact root.`);
  }
}

async function readRegularFile(root, logicalPath, label) {
  if (typeof logicalPath !== "string" || logicalPath.length === 0) {
    throw new Error(`${label} path is required.`);
  }
  const path = resolve(root, logicalPath);
  inside(root, path, label);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
  return readFile(path);
}

function parseCanonicalObject(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON.`, { cause: error });
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !canonicalBytes(value).equals(bytes)
  ) {
    throw new Error(`${label} is not one canonical object.`);
  }
  return value;
}

export function readApplicationMetadata(bytes) {
  const entries = inspectTar(bytes);
  const names = entries.map((entry) => entry.path);
  if (
    names.length !== 2 ||
    !names.includes("application-payload.json") ||
    !names.includes("payload-inventory.json")
  ) {
    throw new Error("Application payload has an unexpected file set.");
  }
  const entry = entries.find((candidate) => candidate.path === "application-payload.json");
  const metadata = parseCanonicalObject(entry.bytes, "Application payload metadata");
  exactKeys(
    metadata,
    [
      "evidence_digest",
      "inventory",
      "migration",
      "provenance_digest",
      "schema_version",
      "server_image",
      "source_sha",
      "web_image",
    ],
    "Application payload metadata",
  );
  if (
    metadata.schema_version !== 1 ||
    !Array.isArray(metadata.inventory) ||
    !digestPattern.test(metadata.evidence_digest) ||
    !digestPattern.test(metadata.provenance_digest)
  ) {
    throw new Error("Application payload metadata differs from its closed schema.");
  }
  return metadata;
}

function validateInput(input) {
  exactKeys(
    input,
    [
      "application_payload_file",
      "certificate_contact",
      "deployment_epoch",
      "deployment_sequence",
      "infrastructure_sha",
      "previous_activation_manifest_digest",
      "previous_release_id",
      "release_id",
      "schema_version",
      "shared_infrastructure_payload_digest",
      "staging",
    ],
    "Initial-staging input",
  );
  exactKeys(
    input.staging,
    [
      "admin_health_cidrs",
      "app_domain",
      "caddy_ip",
      "config_digest",
      "edge_subnet",
      "sealed_input_record_id",
      "sealed_input_record_mac",
    ],
    "Initial-staging environment",
  );
  if (
    input.schema_version !== 1 ||
    input.deployment_sequence !== 1 ||
    input.previous_release_id !== null ||
    input.previous_activation_manifest_digest !== null
  ) {
    throw new Error("Initial staging must be sequence 1 with no predecessor.");
  }
  if (!sourceShaPattern.test(input.infrastructure_sha)) {
    throw new Error("Infrastructure SHA must be one full lowercase Git SHA.");
  }
  if (!digestPattern.test(input.shared_infrastructure_payload_digest)) {
    throw new Error("Shared-infrastructure payload digest is invalid.");
  }
  if (!digestPattern.test(input.staging.config_digest)) {
    throw new Error("Staging configuration digest is invalid.");
  }
}

export async function buildInitialStagingManifest(artifactRoot, input, renderedRoot) {
  const artifacts = resolve(artifactRoot);
  validateInput(input);
  const applicationPayload = await readRegularFile(
    artifacts,
    input.application_payload_file,
    "Application payload",
  );
  const application = readApplicationMetadata(applicationPayload);

  const manifest = {
    active_compose_files: ["infra/compose.yaml", "infra/compose.staging.yaml"],
    certificate_contact: input.certificate_contact,
    change_targets: ["shared-infrastructure", "staging"],
    compose_project: "esmii-host",
    deployment_epoch: input.deployment_epoch,
    deployment_sequence: 1,
    environments: {
      production: null,
      staging: {
        admin_health_cidrs: input.staging.admin_health_cidrs,
        app_domain: input.staging.app_domain,
        application_payload_digest: sha256(applicationPayload),
        caddy_ip: input.staging.caddy_ip,
        ci_evidence_digest: application.evidence_digest,
        config_digest: input.staging.config_digest,
        edge_subnet: input.staging.edge_subnet,
        schema_transition: application.migration,
        sealed_input_record_id: input.staging.sealed_input_record_id,
        sealed_input_record_mac: input.staging.sealed_input_record_mac,
        server_image: application.server_image,
        source_sha: application.source_sha,
        web_image: application.web_image,
      },
    },
    infrastructure_sha: input.infrastructure_sha,
    previous_activation_manifest_digest: null,
    previous_release_id: null,
    promotion_source_checkpoint_digest: null,
    release_id: input.release_id,
    rendered_compose_digest: `sha256:${"0".repeat(64)}`,
    schema_version: 1,
    shared_config_digest: `sha256:${"0".repeat(64)}`,
    shared_infrastructure_payload_digest: input.shared_infrastructure_payload_digest,
  };

  const preview = await renderActivationManifest(manifest, renderedRoot, {
    label: `${input.release_id}-digest-preview`,
    verifyDigest: false,
  });
  manifest.rendered_compose_digest = preview.renderedComposeDigest;
  manifest.shared_config_digest = preview.sharedConfigDigest;
  validateActivationManifest(manifest);
  const rendered = await renderActivationManifest(manifest, renderedRoot, {
    label: input.release_id,
    verifyDigest: true,
  });
  const bytes = canonicalBytes(manifest);
  return { bytes, digest: sha256(bytes), manifest, rendered };
}

async function atomicWrite(path, bytes, mode) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode });
  await rename(temporary, path);
  await chmod(path, mode);
  await rm(temporary, { force: true });
}

export async function writeInitialStagingManifest(artifactRoot, input, outputRoot) {
  const root = resolve(outputRoot);
  await mkdir(root, { mode: 0o700, recursive: true });
  const result = await buildInitialStagingManifest(artifactRoot, input, join(root, "rendered"));
  const manifestPath = join(root, `${result.digest.slice("sha256:".length)}.json`);
  await atomicWrite(manifestPath, result.bytes, 0o600);
  return { ...result, manifestPath };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath) {
  const inputPath = option("--input");
  if (inputPath === undefined) {
    console.error(
      "Usage: staging-manifest.mjs --input <staging.json> [--artifact-root <dir>] [--output <dir>]",
    );
    process.exit(1);
  }
  try {
    const resolvedInput = resolve(inputPath);
    const input = JSON.parse(await readFile(resolvedInput, "utf8"));
    const artifactRoot = resolve(option("--artifact-root") ?? dirname(resolvedInput));
    const outputRoot = resolve(
      option("--output") ?? join(repositoryRoot, ".local", "prompt05", "staging-manifest"),
    );
    const result = await writeInitialStagingManifest(artifactRoot, input, outputRoot);
    console.log(
      JSON.stringify({
        application_payload_digest: result.manifest.environments.staging.application_payload_digest,
        manifest: result.manifestPath,
        manifest_digest: result.digest,
        release_id: result.manifest.release_id,
        rendered_compose_digest: result.rendered.renderedComposeDigest,
        shared_config_digest: result.rendered.sharedConfigDigest,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
