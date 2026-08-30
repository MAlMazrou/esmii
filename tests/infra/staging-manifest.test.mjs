import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplicationPayload } from "../../scripts/application-payload.mjs";
import { inspectTar, makeDeterministicTar } from "../../scripts/infra/payload.mjs";
import { buildInitialStagingManifest } from "../../scripts/staging-manifest.mjs";

const roots = [];
const digest = (character) => `sha256:${character.repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function candidate() {
  const root = await mkdtemp(join(tmpdir(), "esmii-staging-manifest-"));
  roots.push(root);
  const files = {
    evidence: "ci-evidence.json",
    provenance: "provenance.intoto.jsonl",
    server_sbom: "server.spdx.json",
    web_sbom: "web.spdx.json",
  };
  await Promise.all(
    Object.entries(files).map(([label, path]) => writeFile(join(root, path), `${label}\n`, "utf8")),
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
  return {
    application,
    input: {
      application_payload_file: "application.tar",
      certificate_contact: "ops@esmii.app",
      deployment_epoch: "esmii-initial-epoch-0001",
      deployment_sequence: 1,
      infrastructure_sha: "2".repeat(40),
      previous_activation_manifest_digest: null,
      previous_release_id: null,
      release_id: "esmii-staging-0001",
      schema_version: 1,
      shared_infrastructure_payload_digest: digest("c"),
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
    root,
  };
}

describe("initial staging activation manifest", () => {
  it("derives a canonical staging-only manifest and both rendered digests", async () => {
    const fixture = await candidate();
    const first = await buildInitialStagingManifest(
      fixture.root,
      fixture.input,
      join(fixture.root, "rendered-first"),
    );
    const second = await buildInitialStagingManifest(
      fixture.root,
      fixture.input,
      join(fixture.root, "rendered-second"),
    );

    expect(first.digest).toBe(second.digest);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.manifest.environments.production).toBeNull();
    expect(first.manifest.active_compose_files).toEqual([
      "infra/compose.yaml",
      "infra/compose.staging.yaml",
    ]);
    expect(first.manifest.environments.staging.application_payload_digest).toBe(
      fixture.application.digest,
    );
    expect(first.manifest.environments.staging.source_sha).toBe("1".repeat(40));
    expect(first.manifest.rendered_compose_digest).toBe(first.rendered.renderedComposeDigest);
    expect(first.manifest.shared_config_digest).toBe(first.rendered.sharedConfigDigest);
  });

  it("rejects a non-initial sequence and an application payload with extra files", async () => {
    const sequence = await candidate();
    sequence.input.deployment_sequence = 2;
    await expect(
      buildInitialStagingManifest(sequence.root, sequence.input, join(sequence.root, "rendered")),
    ).rejects.toThrow("sequence 1 with no predecessor");

    const extra = await candidate();
    const archive = makeDeterministicTar([
      ...inspectTar(extra.application.bytes).map((entry) => ({ ...entry, mode: 0o644 })),
      { bytes: Buffer.from("extra"), mode: 0o644, path: "unexpected.txt" },
    ]);
    await writeFile(join(extra.root, "application.tar"), archive);
    await expect(
      buildInitialStagingManifest(extra.root, extra.input, join(extra.root, "rendered")),
    ).rejects.toThrow("unexpected file set");
  });
});
