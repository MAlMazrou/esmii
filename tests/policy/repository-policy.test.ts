import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat();
}

describe("repository policy", () => {
  it("does not create environment branches or give hosted runners VPS deployment access", async () => {
    const workflowFiles = await filesUnder(".github/workflows");
    const contents = await Promise.all(workflowFiles.map((file) => readFile(file, "utf8")));
    const joined = contents.join("\n");

    expect(joined).not.toMatch(/branches:\s*\[[^\]]*\b(?:staging|production)\b/u);
    expect(joined).not.toMatch(/branches:\s*(?:staging|production)\s*$/mu);
    expect(joined).not.toMatch(
      /branches:[^\S\r\n]*\r?\n(?:[ \t]+-[^\r\n]+\r?\n)*[ \t]+-[ \t]*(?:staging|production)[ \t]*$/mu,
    );
    expect(joined).not.toMatch(/\b(?:gh release create|wrangler deploy|scp|ssh)\b/u);
    expect(joined).not.toContain("pull_request_target");
  });

  it("publishes immutable branch images and advances environment-specific aliases", async () => {
    const contents = await readFile(".github/workflows/ci.yaml", "utf8");

    expect(contents).toContain("github.event_name == 'push' && github.ref == 'refs/heads/dev'");
    expect(contents).toContain("ghcr.io/malmazrou/esmii-web:sha-${{ github.sha }}");
    expect(contents).toContain("ghcr.io/malmazrou/esmii-server:sha-${{ github.sha }}");
    expect(contents).toContain("ghcr.io/malmazrou/esmii-web:dev");
    expect(contents).toContain("ghcr.io/malmazrou/esmii-server:dev");
    expect(contents).toContain("github.event_name == 'workflow_dispatch'");
    expect(contents).toContain("github.ref == 'refs/heads/main'");
    expect(contents).toContain("ghcr.io/malmazrou/esmii-web:main");
    expect(contents).toContain("ghcr.io/malmazrou/esmii-server:main");
    expect(contents).toContain("docker buildx imagetools create");
    expect(contents).not.toContain(":latest");
  });

  it("pins actions and forbids rebuilds in production-promotion workflows", async () => {
    const workflowFiles = await filesUnder(".github/workflows");

    for (const file of workflowFiles) {
      const contents = await readFile(file, "utf8");
      const actionReferences = [...contents.matchAll(/^\s*uses:\s*([^\s#]+).*$/gmu)];
      for (const [, reference] of actionReferences) {
        expect(reference).toMatch(/@[0-9a-f]{40}$/u);
      }

      if (/promot|production/iu.test(file)) {
        expect(contents).not.toMatch(
          /\b(?:docker\s+(?:build|compose\s+build)|buildx\s+build|pnpm\s+image:build)\b/iu,
        );
      }
    }
  });

  it("keeps environment identity out of Docker build arguments while allowing the public release version", async () => {
    const dockerfiles = ["apps/web/Dockerfile", "apps/server/Dockerfile"];
    for (const dockerfile of dockerfiles) {
      const contents = await readFile(dockerfile, "utf8");
      expect(contents).not.toMatch(/^ARG\s+(?:ENVIRONMENT|STAGING|PRODUCTION)(?:\s|=|$)/mu);
      const publicArguments = [...contents.matchAll(/^ARG\s+(NEXT_PUBLIC_[A-Z0-9_]+)/gmu)].map(
        ([, name]) => name,
      );
      expect(publicArguments).toEqual(
        dockerfile === "apps/web/Dockerfile" ? ["NEXT_PUBLIC_APP_VERSION"] : [],
      );
      expect(contents).not.toContain("esmii.app");
      expect(contents).toContain("org.opencontainers.image.source");
      expect(contents).toContain("org.opencontainers.image.revision");
      expect(contents).toContain("org.opencontainers.image.version");
      expect(contents).toContain("development-uncommitted");
    }
  });

  it("binds CI image provenance to the checked-out GitHub revision", async () => {
    const contents = await readFile(".github/workflows/ci.yaml", "utf8");
    expect(contents).toContain("ESMII_IMAGE_REVISION: ${{ github.sha }}");
    expect(contents).toContain(
      "ESMII_IMAGE_SOURCE: ${{ github.server_url }}/${{ github.repository }}",
    );
  });
});
