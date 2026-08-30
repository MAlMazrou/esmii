import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const units = [
  ["deployment-reconciler", "OnBootSec=2min", "TimeoutStartSec=90"],
  ["health-check", "OnUnitActiveSec=5min", "TimeoutStartSec=90"],
  ["database-backup", "00,06,12,18:15:00 UTC", "TimeoutStartSec=45min"],
  ["state-backup", "01:30:00 UTC", "TimeoutStartSec=2h"],
  ["restore-check", "08:30:00 UTC", "TimeoutStartSec=3h"],
  ["host-prune", "04:30:00 UTC", "TimeoutStartSec=30min"],
  ["maintenance", "*-*-1..7 14:00:00 UTC", "TimeoutStartSec=2h"],
];

describe("systemd operational schedule", () => {
  for (const [name, schedule, runtime] of units) {
    it(`defines a bounded ${name} service/timer pair`, async () => {
      const service = await readFile(resolve(root, `infra/systemd/esmii-${name}.service`), "utf8");
      const timer = await readFile(resolve(root, `infra/systemd/esmii-${name}.timer`), "utf8");
      expect(service).toContain("OnFailure=esmii-alert-failure@%n.service");
      expect(service).toContain(runtime);
      expect(timer).toContain(schedule);
      if (!["deployment-reconciler", "health-check"].includes(name)) {
        expect(timer).toContain("Persistent=true");
      }
    });
  }

  it("creates lock paths at boot before every mutating service", async () => {
    const tmpfiles = await readFile(
      resolve(root, "infra/ansible/roles/directories/files/esmii-locks.conf"),
      "utf8",
    );
    expect(tmpfiles.trim()).toBe("d /run/lock/esmii 0700 root root -");
    for (const name of [
      "database-backup",
      "state-backup",
      "restore-check",
      "host-prune",
      "maintenance",
    ]) {
      const service = await readFile(resolve(root, `infra/systemd/esmii-${name}.service`), "utf8");
      expect(service).toContain("systemd-tmpfiles-setup.service");
    }
  });
});
