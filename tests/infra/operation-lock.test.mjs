import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const controller = join(repositoryRoot, "infra/libexec/esmii_host_control.py");
const roots = [];

async function root() {
  const value = await mkdtemp(join(tmpdir(), "esmii-prompt04-lock-"));
  roots.push(value);
  const lockRoot = join(value, "run/lock/esmii");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  await chmod(lockRoot, 0o700);
  return value;
}

function command(testRoot, ...arguments_) {
  return [controller, "--test-root", testRoot, ...arguments_];
}

function run(testRoot, ...arguments_) {
  return spawnSync("python3", command(testRoot, ...arguments_), {
    encoding: "utf8",
    env: { ESMII_TEST_MODE: "1", PATH: "/usr/bin:/bin" },
  });
}

async function waitForExit(child) {
  return new Promise((resolvePromise) =>
    child.once("exit", (code, signal) => resolvePromise({ code, signal })),
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true })));
});

describe("host operation serialization", () => {
  it("times out under contention, releases on process exit, and rejects reverse lock order", async () => {
    const testRoot = await root();
    const holder = spawn("python3", command(testRoot, "lock-probe", "--hold", "0.8"), {
      env: { ESMII_TEST_MODE: "1", PATH: "/usr/bin:/bin" },
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    const blocked = run(testRoot, "lock-probe", "--timeout", "0.1");
    expect(blocked.status).toBe(78);
    expect(blocked.stderr).toContain("bounded lock timeout");
    await waitForExit(holder);
    expect(run(testRoot, "lock-probe", "--timeout", "0.1").status).toBe(0);
    expect(run(testRoot, "lock-probe", "--kind", "reverse").stderr).toContain("lock order");
  });

  it("revalidates the active predecessor only after acquiring the lock", async () => {
    const testRoot = await root();
    await mkdir(join(testRoot, "var/lib/esmii"), { recursive: true });
    await writeFile(
      join(testRoot, "var/lib/esmii/active.json"),
      '{"release_id":"newer","sequence":2}\n',
    );
    const result = run(
      testRoot,
      "activate-release",
      "candidate",
      "--target",
      "staging",
      "--simulate",
      "--expected-predecessor",
      "older",
    );
    expect(result.status).toBe(78);
    expect(result.stderr).toContain("predecessor changed while waiting");
  });

  it("persists an inhibit marker at every injected activation power-loss boundary", async () => {
    const phases = [
      "predecessor-checked",
      "images-pulled",
      "state-started",
      "migration-complete",
      "application-switched",
      "health-verified",
      "active-pointer-committed",
      "checkpoint-committed",
    ];
    for (const [index, phase] of phases.entries()) {
      const testRoot = await root();
      const result = run(
        testRoot,
        "activate-release",
        `candidate-${index}`,
        "--target",
        "staging",
        "--simulate",
        "--operation-id",
        `power-loss-${index}`,
        "--kill-after",
        phase,
      );
      expect(result.signal).toBe("SIGKILL");
      const inhibit = await readFile(
        join(testRoot, "var/lib/esmii/operations/recovery-inhibit.json"),
        "utf8",
      );
      expect(inhibit).toContain(`power-loss-${index}`);
      const refused = run(
        testRoot,
        "activate-release",
        "next",
        "--target",
        "staging",
        "--simulate",
        "--operation-id",
        "must-not-run",
      );
      expect(refused.status).toBe(78);
      expect(refused.stderr).toContain("recovery inhibit");
    }
  });

  it("archives a complete transaction and clears the inhibit marker", async () => {
    const testRoot = await root();
    const result = run(
      testRoot,
      "activate-release",
      "candidate",
      "--target",
      "staging",
      "--simulate",
      "--operation-id",
      "complete-1",
    );
    expect(result.status).toBe(0);
    expect(await readFile(join(testRoot, "var/lib/esmii/active.json"), "utf8")).toContain(
      "candidate",
    );
    await expect(
      readFile(join(testRoot, "var/lib/esmii/operations/recovery-inhibit.json")),
    ).rejects.toThrow();
    expect(
      await readFile(join(testRoot, "var/lib/esmii/operations/archive/complete-1.json"), "utf8"),
    ).toContain('"result":"committed"');
  });
});
