import { describe, expect, it } from "vitest";

import {
  buildMonitoringHostPayload,
  inspectTar,
  monitoringHostPayloadFiles,
} from "../../scripts/infra/payload.mjs";
import { repositoryRoot } from "../../scripts/infra/core.mjs";

const revision = "7".repeat(40);

describe("Prompt-07 monitoring host payload", () => {
  it("has one deterministic closed inventory bound to the full source revision", async () => {
    const first = await buildMonitoringHostPayload(repositoryRoot, revision);
    const second = await buildMonitoringHostPayload(repositoryRoot, revision);

    expect(first.digest).toBe(second.digest);
    expect(first.bootstrapDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.bootstrapDigest).toBe(second.bootstrapDigest);
    expect(first.verifierDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.verifierDigest).toBe(second.verifierDigest);
    expect(first.verifierBytes.equals(second.verifierBytes)).toBe(true);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.metadata).toEqual({
      file_set: "prompt-07-monitoring-host",
      schema_version: 1,
      source: "https://github.com/malmazrou/esmii",
      source_revision: revision,
    });
    const names = inspectTar(first.bytes).map((entry) => entry.path);
    expect(new Set(names)).toEqual(
      new Set([
        ...monitoringHostPayloadFiles.map((entry) => entry.path),
        "monitoring-host-payload.json",
        "payload-inventory.json",
      ]),
    );
    expect(names.some((path) => path.includes("/tests/"))).toBe(false);
    expect(names).toContain("infra/staging-pull/esmii-staging-pull");
    expect(names).toContain("infra/production-pull/esmii-production-pull");
    expect(names).toContain("infra/monitoring/provision_dashboard_mail.py");
  });

  it("changes identity when the approved source revision changes", async () => {
    const first = await buildMonitoringHostPayload(repositoryRoot, revision);
    const second = await buildMonitoringHostPayload(repositoryRoot, "8".repeat(40));
    expect(second.digest).not.toBe(first.digest);
  });
});
