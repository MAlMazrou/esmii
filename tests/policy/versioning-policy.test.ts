import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("semantic release policy", () => {
  it("keeps the released application at or above v0.1.0 and below v1.0.0", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8"));
    const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(root.version);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(0);
    expect(Number(match?.[2])).toBeGreaterThanOrEqual(1);
    expect(root.private).toBe(true);
  });

  it("runs the release bot on main before dispatching the deployable CI build", async () => {
    const [release, ci] = await Promise.all([
      readFile(".github/workflows/release.yaml", "utf8"),
      readFile(".github/workflows/ci.yaml", "utf8"),
    ]);

    expect(release).toMatch(/push:\n\s+branches:\n\s+- main/u);
    expect(release).toContain("corepack pnpm commitlint");
    expect(release).toContain("corepack pnpm release:prepare");
    expect(release).toContain("github-actions[bot]");
    expect(release).toContain('git push origin "refs/tags/${RELEASE_VERSION}"');
    expect(release).toContain('git merge --no-commit --no-ff "${RELEASED_SHA}"');
    expect(release).toContain('git checkout "${RELEASED_SHA}" -- package.json CHANGELOG.md');
    expect(release).toContain("git diff --cached --quiet");
    expect(release.indexOf("corepack pnpm release:prepare")).toBeLessThan(
      release.indexOf("gh workflow run ci.yaml --ref main"),
    );

    const pushTrigger = ci.slice(ci.indexOf("  push:"), ci.indexOf("  workflow_dispatch:"));
    expect(pushTrigger).toContain("- dev");
    expect(pushTrigger).not.toContain("- main");
    expect(ci).toContain("node scripts/verify-version-context.mjs");
  });

  it("passes the package-derived version before the Next.js Docker build", async () => {
    const [dockerfile, images, nextConfig] = await Promise.all([
      readFile("apps/web/Dockerfile", "utf8"),
      readFile("scripts/images.mjs", "utf8"),
      readFile("apps/web/next.config.ts", "utf8"),
    ]);

    expect(dockerfile).toContain("ARG NEXT_PUBLIC_APP_VERSION");
    expect(dockerfile.indexOf("ARG NEXT_PUBLIC_APP_VERSION")).toBeLessThan(
      dockerfile.indexOf("corepack pnpm --filter @esmii/web build"),
    );
    expect(images).toContain("NEXT_PUBLIC_APP_VERSION=${appVersion}");
    expect(nextConfig).toContain("NEXT_PUBLIC_APP_VERSION: appVersion");
    expect(nextConfig).toContain("does not match package.json");
  });

  it("keeps the future version-page seam discoverable", async () => {
    const documentation = await readFile("docs/versioning.md", "utf8");
    expect(documentation).toContain("## Future version page");
    expect(documentation).toContain("apps/web/lib/app-version.ts");
    expect(documentation).toContain("apps/web/components/app-version.tsx");
    expect(documentation).toContain("CHANGELOG.md");
  });

  it("checks only newly pushed first-parent history after a branch merge", async () => {
    const commitlint = await readFile("scripts/commitlint-ci.mjs", "utf8");
    expect(commitlint).toContain('"rev-list", "--first-parent", "--reverse"');
  });
  it("does not reject valid squash commits solely for wrapped body prose", async () => {
    const configuration = await readFile("commitlint.config.mjs", "utf8");
    expect(configuration).toContain('"body-max-line-length": [0]');
  });

  it("formats generated release metadata before the tag is finalized", async () => {
    const releaseScript = await readFile("scripts/release-version.mjs", "utf8");
    expect(releaseScript).toContain(
      '["pnpm", "exec", "prettier", "--write", "package.json", "CHANGELOG.md"]',
    );
    expect(releaseScript).toContain('["commit", "--amend", "--no-edit"]');
    expect(releaseScript).toContain('["tag", "--force", expectedVersion]');
  });
});
