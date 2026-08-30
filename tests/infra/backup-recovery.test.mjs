import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const controller = join(repositoryRoot, "infra/libexec/esmii_host_control.py");
const roots = [];
const digest = (character) => `sha256:${character.repeat(64)}`;

async function root() {
  const value = await mkdtemp(join(tmpdir(), "esmii-prompt04-backup-"));
  roots.push(value);
  await mkdir(join(value, "run/lock/esmii"), { recursive: true, mode: 0o700 });
  await mkdir(join(value, "etc/myapp/secrets/production"), { recursive: true, mode: 0o700 });
  await mkdir(join(value, "srv/myapp/production/backup-staging"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(value, "etc/myapp/secrets/production/restic.env"),
    "RESTIC_REPOSITORY=https://backup.invalid/esmii\nRESTIC_PASSWORD_FILE=/etc/myapp/secrets/production/restic-password\n",
  );
  return value;
}

function run(testRoot, arguments_, extraEnvironment = {}) {
  return spawnSync("python3", [controller, "--test-root", testRoot, ...arguments_], {
    encoding: "utf8",
    env: { ESMII_TEST_MODE: "1", PATH: "/usr/bin:/bin", ...extraEnvironment },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true })));
});

describe("backup and replay recovery", () => {
  it("rejects ambient Restic configuration and never installs retention deletion on the VPS", async () => {
    const testRoot = await root();
    const rejected = run(testRoot, ["backup", "--kind", "database", "--dry-run"], {
      RESTIC_REPOSITORY: "caller-controlled",
    });
    expect(rejected.status).toBe(78);
    expect(rejected.stderr).toContain("ambient RESTIC");
    const controllerSource = await readFile(controller, "utf8");
    expect(controllerSource).not.toMatch(/restic(?:"|')?,?\s+(?:forget|prune|delete)/u);
    const operator = await readFile(
      join(repositoryRoot, "infra/operator/restic-retention.sh"),
      "utf8",
    );
    expect(operator).toContain("restic forget");
    expect(operator).toContain("approved-off-vps");
  });

  it("enforces measured restore capacity before creating an isolated marker", async () => {
    const testRoot = await root();
    const rejected = run(testRoot, ["restore-check", "--required-bytes", "999999999999999"]);
    expect(rejected.status).toBe(78);
    expect(rejected.stderr).toContain("70 percent action or 20 percent reserve");
    const accepted = run(testRoot, ["restore-check", "--required-bytes", "1"]);
    expect(accepted.status).toBe(0);
    expect(
      await readFile(
        join(testRoot, "srv/myapp/production/backup-staging/restore-check.complete"),
        "utf8",
      ),
    ).toContain('"egress":"none"');
  });

  it("refuses a restored local replay floor that differs from off-VPS high water", async () => {
    const testRoot = await root();
    const manifest = {
      change_targets: ["staging"],
      deployment_epoch: "epoch-1",
      deployment_sequence: 3,
      release_id: "candidate-3",
    };
    await mkdir(join(testRoot, "srv/myapp/releases/candidate-3"), { recursive: true });
    await writeFile(
      join(testRoot, "srv/myapp/releases/candidate-3/activation-manifest.json"),
      `${JSON.stringify(manifest)}\n`,
    );
    const local = { deployment_epoch: "epoch-1", deployment_sequence: 1 };
    const remote = { deployment_epoch: "epoch-1", deployment_sequence: 2 };
    await mkdir(join(testRoot, "var/lib/esmii"), { recursive: true });
    await writeFile(
      join(testRoot, "var/lib/esmii/checkpoint-high-water.json"),
      `${JSON.stringify(local)}\n`,
    );
    await mkdir(join(testRoot, "off-vps-checkpoint/epoch-1"), { recursive: true });
    await writeFile(
      join(testRoot, "off-vps-checkpoint/epoch-1/00000000000000000002.json"),
      `${JSON.stringify(remote)}\n`,
    );
    const result = run(testRoot, [
      "checkpoint",
      "candidate-3",
      "--deployment-id",
      "deployment-3",
      "--host-evidence-digest",
      digest("e"),
      "--staging-policy-digest",
      digest("f"),
    ]);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain("off-VPS authority");
  });
});
