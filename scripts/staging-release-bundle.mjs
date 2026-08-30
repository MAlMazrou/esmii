import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  repositoryRoot,
  sha256,
  validateActivationManifest,
} from "./infra/core.mjs";
import { readApplicationMetadata } from "./staging-manifest.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function canonicalBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
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

function exactArray(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`${label} differs from the initial-staging contract.`);
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required.`);
  }
}

function validateInitialStaging(manifest) {
  validateActivationManifest(manifest);
  if (
    manifest.deployment_sequence !== 1 ||
    manifest.previous_release_id !== null ||
    manifest.previous_activation_manifest_digest !== null ||
    manifest.promotion_source_checkpoint_digest !== null ||
    manifest.environments.production !== null
  ) {
    throw new Error("Release bundle accepts only initial staging with production inactive.");
  }
  exactArray(
    manifest.active_compose_files,
    ["infra/compose.yaml", "infra/compose.staging.yaml"],
    "Active Compose files",
  );
  exactArray(manifest.change_targets, ["shared-infrastructure", "staging"], "Change targets");
}

function verifyApplication(manifest, bytes) {
  const staging = manifest.environments.staging;
  const metadata = readApplicationMetadata(bytes);
  if (
    sha256(bytes) !== staging.application_payload_digest ||
    metadata.source_sha !== staging.source_sha ||
    metadata.web_image !== staging.web_image ||
    metadata.server_image !== staging.server_image ||
    metadata.evidence_digest !== staging.ci_evidence_digest ||
    canonicalJson(metadata.migration) !== canonicalJson(staging.schema_transition)
  ) {
    throw new Error("Application payload differs from the staging manifest.");
  }
  return metadata;
}

export function buildStagingReleaseBundle({
  applicationPayload,
  checkpointTarget,
  manifestBytes,
  sharedPayload,
  targetHost,
}) {
  requireText(targetHost, "Target host");
  requireText(checkpointTarget, "Checkpoint target");
  const manifest = parseCanonicalObject(manifestBytes, "Activation manifest");
  validateInitialStaging(manifest);
  const manifestDigest = sha256(manifestBytes);
  const sharedDigest = sha256(sharedPayload);
  if (
    !digestPattern.test(manifestDigest) ||
    sharedDigest !== manifest.shared_infrastructure_payload_digest
  ) {
    throw new Error("Shared-infrastructure payload differs from the staging manifest.");
  }
  verifyApplication(manifest, applicationPayload);
  const staging = manifest.environments.staging;
  const applicationDigest = staging.application_payload_digest;

  const installApproval = {
    activation_manifest_digest: manifestDigest,
    application_payload_digests: [applicationDigest],
    release_id: manifest.release_id,
    shared_payload_digest: sharedDigest,
  };
  const activationApproval = {
    activation_manifest_digest: manifestDigest,
    expected_predecessor: null,
    release_id: manifest.release_id,
    target: "staging",
  };
  const review = {
    active_compose_files: manifest.active_compose_files,
    admin_health_cidrs: staging.admin_health_cidrs,
    application_payload_digest: applicationDigest,
    app_domain: staging.app_domain,
    caddy_ip: staging.caddy_ip,
    change_targets: manifest.change_targets,
    checkpoint_target: checkpointTarget,
    ci_evidence_digest: staging.ci_evidence_digest,
    config_digest: staging.config_digest,
    deployment_epoch: manifest.deployment_epoch,
    deployment_sequence: manifest.deployment_sequence,
    edge_subnet: staging.edge_subnet,
    infrastructure_sha: manifest.infrastructure_sha,
    migration: staging.schema_transition,
    production: null,
    release_id: manifest.release_id,
    rendered_compose_digest: manifest.rendered_compose_digest,
    schema_version: 1,
    sealed_input_record_id: staging.sealed_input_record_id,
    sealed_input_record_mac: staging.sealed_input_record_mac,
    server_image: staging.server_image,
    shared_config_digest: manifest.shared_config_digest,
    shared_infrastructure_payload_digest: sharedDigest,
    source_sha: staging.source_sha,
    staging_activation_manifest_digest: manifestDigest,
    target_host: targetHost,
    web_image: staging.web_image,
  };

  return {
    activationApproval,
    applicationDigest,
    installApproval,
    manifest,
    manifestDigest,
    review,
    sharedDigest,
  };
}

async function readRegularFile(path, label) {
  const resolved = resolve(path);
  const metadata = await lstat(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
  return { bytes: await readFile(resolved), path: resolved };
}

async function atomicWrite(path, bytes, mode) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode });
  await rename(temporary, path);
  await chmod(path, mode);
  await rm(temporary, { force: true });
}

async function atomicCopy(source, destination, mode) {
  const temporary = `${destination}.${process.pid}.tmp`;
  await copyFile(source, temporary, 0);
  await chmod(temporary, mode);
  await rename(temporary, destination);
  await rm(temporary, { force: true });
}

export async function writeStagingReleaseBundle({
  applicationPayloadPath,
  checkpointTarget,
  manifestPath,
  outputRoot,
  sharedPayloadPath,
  targetHost,
}) {
  const [manifestFile, sharedFile, applicationFile] = await Promise.all([
    readRegularFile(manifestPath, "Activation manifest"),
    readRegularFile(sharedPayloadPath, "Shared-infrastructure payload"),
    readRegularFile(applicationPayloadPath, "Application payload"),
  ]);
  const bundle = buildStagingReleaseBundle({
    applicationPayload: applicationFile.bytes,
    checkpointTarget,
    manifestBytes: manifestFile.bytes,
    sharedPayload: sharedFile.bytes,
    targetHost,
  });
  const expectedManifestName = `${bundle.manifestDigest.slice("sha256:".length)}.json`;
  if (basename(manifestFile.path) !== expectedManifestName) {
    throw new Error("Activation manifest input is not digest-addressed.");
  }

  const root = resolve(outputRoot);
  await mkdir(dirname(root), { mode: 0o700, recursive: true });
  await mkdir(root, { mode: 0o700 });
  const inbox = join(root, "release-inbox");
  const approvals = join(root, "root-approvals");
  await Promise.all([mkdir(inbox, { mode: 0o700 }), mkdir(approvals, { mode: 0o700 })]);
  await Promise.all([
    atomicCopy(manifestFile.path, join(inbox, expectedManifestName), 0o600),
    atomicCopy(
      sharedFile.path,
      join(inbox, `${bundle.sharedDigest.slice("sha256:".length)}.tar`),
      0o600,
    ),
    atomicCopy(
      applicationFile.path,
      join(inbox, `${bundle.applicationDigest.slice("sha256:".length)}.tar`),
      0o600,
    ),
    atomicWrite(
      join(approvals, `${bundle.manifest.release_id}.json`),
      canonicalBytes(bundle.installApproval),
      0o600,
    ),
    atomicWrite(
      join(approvals, `${bundle.manifest.release_id}.activate.json`),
      canonicalBytes(bundle.activationApproval),
      0o600,
    ),
    atomicWrite(join(root, "release-review.json"), canonicalBytes(bundle.review), 0o600),
  ]);
  return { ...bundle, outputRoot: root };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath) {
  const manifestPath = option("--manifest");
  const sharedPayloadPath = option("--shared-payload");
  const applicationPayloadPath = option("--application-payload");
  const targetHost = option("--target-host");
  const checkpointTarget = option("--checkpoint-target");
  if (
    manifestPath === undefined ||
    sharedPayloadPath === undefined ||
    applicationPayloadPath === undefined ||
    targetHost === undefined ||
    checkpointTarget === undefined
  ) {
    console.error(
      "Usage: staging-release-bundle.mjs --manifest <digest.json> --shared-payload <tar> --application-payload <tar> --target-host <host> --checkpoint-target <target> [--output <dir>]",
    );
    process.exit(1);
  }
  try {
    const outputRoot = resolve(
      option("--output") ?? join(repositoryRoot, ".local", "prompt05", "staging-release-bundle"),
    );
    const bundle = await writeStagingReleaseBundle({
      applicationPayloadPath,
      checkpointTarget,
      manifestPath,
      outputRoot,
      sharedPayloadPath,
      targetHost,
    });
    console.log(
      JSON.stringify({
        activation_manifest_digest: bundle.manifestDigest,
        application_payload_digest: bundle.applicationDigest,
        output: bundle.outputRoot,
        release_id: bundle.manifest.release_id,
        shared_payload_digest: bundle.sharedDigest,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
