import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { readFixtureManifest, validateActivationManifest } from "../../scripts/infra/core.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const controller = join(repositoryRoot, "infra/libexec/esmii_host_control.py");
const roots = [];

async function root() {
  const value = await mkdtemp(join(tmpdir(), "esmii-prompt04-security-"));
  roots.push(value);
  return value;
}

function run(testRoot, ...arguments_) {
  return spawnSync("python3", [controller, "--test-root", testRoot, ...arguments_], {
    encoding: "utf8",
    env: { ESMII_TEST_MODE: "1", PATH: "/usr/bin:/bin" },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true })));
});

describe("host security boundaries", () => {
  it("rejects mutable images, extra manifest keys, and production in the initial overlay", async () => {
    const source = await readFixtureManifest("staging");
    const mutable = structuredClone(source);
    mutable.environments.staging.web_image = "ghcr.io/malmazrou/esmii-web:latest";
    expect(() => validateActivationManifest(mutable)).toThrow(
      "application images must be registry digests",
    );

    const extra = structuredClone(source);
    extra.unreviewed = true;
    expect(() => validateActivationManifest(extra)).toThrow("manifest keys differ");

    const production = structuredClone(source);
    production.environments.production = structuredClone(
      (await readFixtureManifest("production-restricted")).environments.production,
    );
    expect(() => validateActivationManifest(production)).toThrow(
      "production requires base+staging+production",
    );
  });

  it("keeps action credentials out of Caddy and application request logs", async () => {
    const sentinel = "PROMPT04_SENTINEL_MAGIC_OAUTH_QUERY_COOKIE_AUTH";
    const sources = await Promise.all(
      [
        "infra/caddy/sites/staging.caddy",
        "infra/caddy/sites/production-restricted.caddy",
        "infra/caddy/sites/production-public.caddy",
        "apps/server/src/observability/logger.ts",
      ].map((path) => readFile(join(repositoryRoot, path), "utf8")),
    );
    expect(sources.join("\n")).not.toContain(sentinel);
    expect(sources[0]).toContain("log_skip @action_routes");
    expect(sources[1]).toContain("log_skip @action_routes");
    expect(sources[2]).toContain("log_skip @action_routes");
    expect(sources[3]).toMatch(/req\.headers\.authorization/u);
    expect(sources[3]).toMatch(/req\.headers\.cookie/u);
  });

  it("accepts only content-hashed regular public variants and rejects symlinks", async () => {
    const testRoot = await root();
    const variants = join(testRoot, "srv/myapp/staging/media/public/variants");
    await mkdir(variants, { recursive: true, mode: 0o755 });
    const bytes = Buffer.from("synthetic-published-variant");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const shard = join(variants, digest.slice(0, 2), digest.slice(2, 4));
    await mkdir(shard, { recursive: true });
    await writeFile(join(shard, `${digest}-v1-320x240.webp`), bytes);
    expect(run(testRoot, "verify-public-tree", "staging").status).toBe(0);
    await symlink(
      join(shard, `${digest}-v1-320x240.webp`),
      join(shard, `${digest}-v1-640x480.webp`),
    );
    const rejected = run(testRoot, "verify-public-tree", "staging");
    expect(rejected.status).toBe(78);
    expect(rejected.stderr).toContain("symlink or nonregular");
  });
});
