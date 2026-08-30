import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  renderFixture,
  validateSealedRelease,
  validatedHostComposeSubcommand,
} from "../../scripts/infra/core.mjs";

const roots = [];

async function root() {
  const value = await mkdtemp(join(tmpdir(), "esmii-prompt04-seal-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true })));
});

describe("host Compose wrapper", () => {
  it("allows verification/status only and denies mutation subcommands", () => {
    expect(validatedHostComposeSubcommand("verify")).toEqual([]);
    expect(validatedHostComposeSubcommand("config")).toEqual(["config", "--quiet"]);
    expect(validatedHostComposeSubcommand("ps")).toEqual(["ps"]);
    for (const command of ["up", "pull", "run", "down", "exec", "--env-file"]) {
      expect(() => validatedHostComposeSubcommand(command)).toThrow("forbidden");
    }
  });

  it("detects checksum drift in a sealed release", async () => {
    const rendered = await renderFixture("staging", await root());
    await chmod(join(rendered.outputRoot, "seal.json"), 0o444);
    await expect(validateSealedRelease(rendered.outputRoot)).resolves.toMatchObject({
      release_id: "fixture-staging",
    });
    const composePath = join(rendered.outputRoot, "infra/compose.staging.yaml");
    await chmod(composePath, 0o644);
    await writeFile(composePath, `${await readFile(composePath, "utf8")}\n# drift\n`);
    await expect(validateSealedRelease(rendered.outputRoot)).rejects.toThrow("digest drifted");
  });

  it("rejects a symlinked seal", async () => {
    const rendered = await renderFixture("staging", await root());
    const seal = join(rendered.outputRoot, "seal.json");
    const moved = join(rendered.outputRoot, "seal.real.json");
    await chmod(seal, 0o444);
    await writeFile(moved, await readFile(seal));
    await rm(seal);
    await symlink(moved, seal);
    await expect(validateSealedRelease(rendered.outputRoot)).rejects.toThrow("unsafe");
  });
});
