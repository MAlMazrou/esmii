import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildSharedInfrastructurePayload,
  inspectTar,
  makeDeterministicTar,
} from "../../scripts/infra/payload.mjs";
import { repositoryRoot } from "../../scripts/infra/core.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true })));
});

describe("immutable release payloads", () => {
  it("rebuilds identical normalized bytes and inventory", async () => {
    const first = await buildSharedInfrastructurePayload(repositoryRoot);
    const second = await buildSharedInfrastructurePayload(repositoryRoot);
    expect(first.digest).toBe(second.digest);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(inspectTar(first.bytes).at(-1)?.path).toBe("payload-inventory.json");
  });

  it("rejects traversal, duplicate, and nonregular archive members", () => {
    const unsafe = makeDeterministicTar([
      { bytes: Buffer.from("x"), mode: 0o644, path: "../escape" },
    ]);
    expect(() => inspectTar(unsafe)).toThrow("Unsafe archive path");

    const duplicate = makeDeterministicTar([
      { bytes: Buffer.from("x"), mode: 0o644, path: "infra/a" },
      { bytes: Buffer.from("y"), mode: 0o644, path: "infra/a" },
    ]);
    expect(() => inspectTar(duplicate)).toThrow("Duplicate archive path");

    const nonregular = makeDeterministicTar([
      { bytes: Buffer.from("x"), mode: 0o644, path: "infra/a" },
    ]);
    nonregular[156] = "2".charCodeAt(0);
    expect(() => inspectTar(nonregular)).toThrow("Unsafe archive entry type");
  });

  it("normalizes every payload path, owner, timestamp, and mode", async () => {
    const payload = await buildSharedInfrastructurePayload(repositoryRoot);
    expect(payload.inventory.normalized).toEqual({
      gid: 0,
      mtime: 0,
      order: "path-byte-order",
      uid: 0,
    });
    expect(payload.inventory.files.every((entry) => entry.path.startsWith("infra/"))).toBe(true);
    expect(payload.inventory.files.every((entry) => ["0644", "0755"].includes(entry.mode))).toBe(
      true,
    );
    expect(payload.inventory.files.some((entry) => entry.path.includes("release/fixtures"))).toBe(
      false,
    );
  });
});
