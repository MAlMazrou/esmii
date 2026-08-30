import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readFixtureManifest,
  renderFixture,
  validateSourceTemplates,
  validateTransition,
} from "../../scripts/infra/core.mjs";

const temporaryRoots = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "esmii-prompt04-render-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("sealed host rendering", () => {
  it("allows only the reviewed source-template tokens", async () => {
    await expect(validateSourceTemplates()).resolves.toEqual({ schemas: 8, templates: 7 });
  });

  for (const fixture of ["staging", "production-restricted", "production-public"]) {
    it(`reproduces the canonical ${fixture} digests without unresolved inputs`, async () => {
      const rendered = await renderFixture(fixture, await temporaryRoot());
      for (const logical of rendered.manifest.active_compose_files) {
        const source = await readFile(join(rendered.outputRoot, logical), "utf8");
        expect(source).not.toMatch(/@@|\$\{|<\w[^>]*>/u);
      }
      expect(rendered.renderedComposeDigest).toBe(rendered.manifest.rendered_compose_digest);
      expect(rendered.sharedConfigDigest).toBe(rendered.manifest.shared_config_digest);
    });
  }

  it("starts with production null and promotes without dropping staging", async () => {
    const staging = await readFixtureManifest("staging");
    const restricted = await readFixtureManifest("production-restricted");
    const publicManifest = await readFixtureManifest("production-public");
    expect(staging.environments.production).toBeNull();
    expect(restricted.environments.staging).toEqual(staging.environments.staging);
    expect(() => validateTransition(staging, restricted, "production")).not.toThrow();
    expect(() => validateTransition(restricted, publicManifest, "public-edge")).not.toThrow();
  });

  it("rejects a public-edge record that mutates staging or production application state", async () => {
    const restricted = await readFixtureManifest("production-restricted");
    const publicManifest = structuredClone(await readFixtureManifest("production-public"));
    publicManifest.environments.staging.app_domain = "changed.esmii.invalid";
    expect(() => validateTransition(restricted, publicManifest, "public-edge")).toThrow(
      "public edge changed staging",
    );
  });
});
