import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplicationPayload } from "../../scripts/application-payload.mjs";
import { inspectTar } from "../../scripts/infra/payload.mjs";

const roots = [];
const digest = (character) => `sha256:${character.repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "esmii-application-payload-"));
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
  return {
    artifactRoot: root,
    input: {
      files,
      migration: { from: "empty", to: "0001_prompt03_identity_organizations" },
      schema_version: 1,
      server_image: `ghcr.io/malmazrou/esmii-server@${digest("b")}`,
      source_sha: "1".repeat(40),
      web_image: `ghcr.io/malmazrou/esmii-web@${digest("a")}`,
    },
  };
}

describe("immutable application payload", () => {
  it("rebuilds canonical deterministic bytes from exact release evidence", async () => {
    const candidate = await fixture();
    const first = await buildApplicationPayload(
      process.cwd(),
      candidate.artifactRoot,
      candidate.input,
    );
    const second = await buildApplicationPayload(
      process.cwd(),
      candidate.artifactRoot,
      candidate.input,
    );

    expect(first.digest).toBe(second.digest);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(inspectTar(first.bytes).map((entry) => entry.path)).toEqual([
      "application-payload.json",
      "payload-inventory.json",
    ]);
    expect(first.metadata.inventory.map((entry) => entry.path)).toEqual(
      [...first.metadata.inventory.map((entry) => entry.path)].sort(),
    );
    expect(first.metadata.inventory).toContainEqual(
      expect.objectContaining({
        kind: "migration",
        path: "packages/database/migrations/0001_prompt03_identity_organizations.sql",
      }),
    );
    expect(first.metadata.inventory).toContainEqual(
      expect.objectContaining({ kind: "dependency-lock", path: "pnpm-lock.yaml" }),
    );
    expect(first.metadata.inventory.filter((entry) => entry.kind === "sbom")).toHaveLength(2);
  });

  it("rejects mutable images, unknown migrations, and symlinked evidence", async () => {
    const mutable = await fixture();
    mutable.input.web_image = "ghcr.io/malmazrou/esmii-web:latest";
    await expect(
      buildApplicationPayload(process.cwd(), mutable.artifactRoot, mutable.input),
    ).rejects.toThrow("immutable Esmii GHCR digests");

    const migration = await fixture();
    migration.input.migration.to = "9999_missing";
    await expect(
      buildApplicationPayload(process.cwd(), migration.artifactRoot, migration.input),
    ).rejects.toThrow("Target migration is absent");

    const linked = await fixture();
    await symlink(
      join(linked.artifactRoot, linked.input.files.evidence),
      join(linked.artifactRoot, "link"),
    );
    linked.input.files.evidence = "link";
    await expect(
      buildApplicationPayload(process.cwd(), linked.artifactRoot, linked.input),
    ).rejects.toThrow("regular non-symlink file");
  });
});
