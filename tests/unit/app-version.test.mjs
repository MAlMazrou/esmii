import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertPreOneVersion,
  readPublicAppVersion,
  withAppVersionEnvironment,
} from "../../scripts/app-version.mjs";
import { classifyPreOneBump, nextPreOneVersion } from "../../scripts/version-policy.mjs";

describe("application version", () => {
  it("formats the root pre-1.0 semantic version for browser and image metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "esmii-version-"));
    await writeFile(join(root, "package.json"), '{"version":"0.3.2"}\n');

    expect(readPublicAppVersion(root)).toBe("v0.3.2");
    expect(withAppVersionEnvironment({}, root)).toMatchObject({
      ESMII_APP_VERSION: "v0.3.2",
      NEXT_PUBLIC_APP_VERSION: "v0.3.2",
    });
  });

  it("rejects malformed, prerelease, and stable-major versions", () => {
    for (const version of ["1.0.0", "0.1.0-beta.1", "v0.1.0", "00.1.0", "0.01.0"]) {
      expect(() => assertPreOneVersion(version)).toThrow(/pre-1\.0 semantic version/u);
    }
  });

  it("rejects a caller-supplied build version that differs from package.json", () => {
    expect(() => withAppVersionEnvironment({ NEXT_PUBLIC_APP_VERSION: "v0.9.9" })).toThrow(
      /does not match package\.json/u,
    );
  });

  it("keeps ordinary work on patch releases and breaking work below 1.0", () => {
    expect(classifyPreOneBump("fix: correct a link")).toBe("patch");
    expect(classifyPreOneBump("feat: add a settings page")).toBe("patch");
    expect(nextPreOneVersion("0.3.2", "feat: add a settings page")).toBe("0.3.3");
    expect(nextPreOneVersion("0.3.2", "feat!: replace the account contract")).toBe("0.4.0");
    expect(nextPreOneVersion("0.3.2", "fix: update behavior\n\nBREAKING CHANGE: new API")).toBe(
      "0.4.0",
    );
  });
});
