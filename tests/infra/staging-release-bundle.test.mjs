import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplicationPayload } from "../../scripts/application-payload.mjs";
import { buildSharedInfrastructurePayload } from "../../scripts/infra/payload.mjs";
import { buildInitialStagingManifest } from "../../scripts/staging-manifest.mjs";
import {
  buildStagingReleaseBundle,
  writeStagingReleaseBundle,
} from "../../scripts/staging-release-bundle.mjs";

const roots = [];
const digest = (character) => `sha256:${character.repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "esmii-staging-release-bundle-"));
  roots.push(root);
  const files = {
    evidence: "ci-evidence.json",
    provenance: "provenance.intoto.jsonl",
    server_sbom: "server.spdx.json",
    web_sbom: "web.spdx.json",
  };
  await Promise.all(
    Object.entries(files).map(([label, path]) => writeFile(join(root, path), `${label}\n`)),
  );
  const application = await buildApplicationPayload(process.cwd(), root, {
    files,
    migration: { from: "empty", to: "0001_prompt03_identity_organizations" },
    schema_version: 1,
    server_image: `ghcr.io/malmazrou/esmii-server@${digest("b")}`,
    source_sha: "1".repeat(40),
    web_image: `ghcr.io/malmazrou/esmii-web@${digest("a")}`,
  });
  await writeFile(join(root, "application.tar"), application.bytes);
  const shared = await buildSharedInfrastructurePayload(process.cwd());
  await writeFile(join(root, "shared.tar"), shared.bytes);
  const manifest = await buildInitialStagingManifest(
    root,
    {
      application_payload_file: "application.tar",
      certificate_contact: "ops@esmii.app",
      deployment_epoch: "esmii-initial-epoch-0001",
      deployment_sequence: 1,
      infrastructure_sha: "2".repeat(40),
      previous_activation_manifest_digest: null,
      previous_release_id: null,
      release_id: "esmii-staging-0001",
      schema_version: 1,
      shared_infrastructure_payload_digest: shared.digest,
      staging: {
        admin_health_cidrs: ["10.77.0.2/32"],
        app_domain: "staging.esmii.app",
        caddy_ip: "172.30.10.2",
        config_digest: digest("d"),
        edge_subnet: "172.30.10.0/24",
        sealed_input_record_id: "staging-input-0001",
        sealed_input_record_mac: `hmac-sha256:${"e".repeat(64)}`,
      },
    },
    join(root, "rendered"),
  );
  const manifestPath = join(root, `${manifest.digest.slice("sha256:".length)}.json`);
  await writeFile(manifestPath, manifest.bytes);
  return { application, manifest, manifestPath, root, shared };
}

describe("initial staging release review bundle", () => {
  it("writes the exact digest-addressed inbox and separate root approvals", async () => {
    const candidate = await fixture();
    const output = join(candidate.root, "bundle");
    const bundle = await writeStagingReleaseBundle({
      applicationPayloadPath: join(candidate.root, "application.tar"),
      checkpointTarget: "r2://esmii-staging-checkpoints/epoch-0001",
      manifestPath: candidate.manifestPath,
      outputRoot: output,
      sharedPayloadPath: join(candidate.root, "shared.tar"),
      targetHost: "152.53.251.34",
    });

    expect((await readdir(join(output, "release-inbox"))).sort()).toEqual(
      [
        `${bundle.applicationDigest.slice("sha256:".length)}.tar`,
        `${bundle.manifestDigest.slice("sha256:".length)}.json`,
        `${bundle.sharedDigest.slice("sha256:".length)}.tar`,
      ].sort(),
    );
    expect(JSON.parse(await readFile(join(output, "release-review.json"), "utf8"))).toEqual(
      expect.objectContaining({
        production: null,
        target_host: "152.53.251.34",
      }),
    );
    expect(
      JSON.parse(await readFile(join(output, "root-approvals", "esmii-staging-0001.json"), "utf8")),
    ).toEqual(bundle.installApproval);
    expect(
      JSON.parse(
        await readFile(join(output, "root-approvals", "esmii-staging-0001.activate.json"), "utf8"),
      ),
    ).toEqual(bundle.activationApproval);
  });

  it("rejects payload drift and any production-bearing manifest", async () => {
    const candidate = await fixture();
    expect(() =>
      buildStagingReleaseBundle({
        applicationPayload: Buffer.concat([candidate.application.bytes, Buffer.from("drift")]),
        checkpointTarget: "r2://esmii-staging-checkpoints/epoch-0001",
        manifestBytes: candidate.manifest.bytes,
        sharedPayload: candidate.shared.bytes,
        targetHost: "152.53.251.34",
      }),
    ).toThrow("Application payload differs");

    const unsafe = structuredClone(candidate.manifest.manifest);
    unsafe.environments.production = structuredClone(unsafe.environments.staging);
    const unsafeBytes = Buffer.from(`${JSON.stringify(unsafe)}\n`);
    expect(() =>
      buildStagingReleaseBundle({
        applicationPayload: candidate.application.bytes,
        checkpointTarget: "r2://esmii-staging-checkpoints/epoch-0001",
        manifestBytes: unsafeBytes,
        sharedPayload: candidate.shared.bytes,
        targetHost: "152.53.251.34",
      }),
    ).toThrow(/canonical|production inactive|production requires/u);
  });
});
