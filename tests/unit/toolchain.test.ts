import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("root toolchain contract", () => {
  it("pins the supported Node and pnpm versions", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      engines: Record<string, string>;
      packageManager: string;
    };

    expect(manifest.engines).toEqual({ node: "24.20.0", pnpm: "11.21.0" });
    expect(manifest.packageManager).toBe("pnpm@11.21.0");
  });
});
