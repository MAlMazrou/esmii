import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { FilesystemStorageAdapter, StorageKeyError } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function adapter() {
  const root = await mkdtemp(join(tmpdir(), "esmii-storage-test-"));
  roots.push(root);
  return new FilesystemStorageAdapter({
    roots: {
      "private-incoming": join(root, "private-incoming"),
      "private-originals": join(root, "private-originals"),
      "private-trash": join(root, "private-trash"),
      "private-variants": join(root, "private-variants"),
      "public-variants": join(root, "public-variants"),
    },
    temporaryDownloadUrl: ({ scope, key }) =>
      new URL(`http://localhost:8080/api/storage/${scope}/${encodeURIComponent(key)}`),
  });
}

describe("FilesystemStorageAdapter", () => {
  it("writes only streams that match declared size and digest", async () => {
    const storage = await adapter();
    const bytes = Buffer.from("synthetic storage bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    await storage.put("private-incoming", Readable.from(bytes), "fixture/object.bin", {
      byteSize: bytes.length,
      contentType: "application/octet-stream",
      sha256,
    });

    expect(await storage.head("private-incoming", "fixture/object.bin")).toMatchObject({
      byteSize: bytes.length,
      sha256,
    });
    const stream = await storage.openReadStream("private-incoming", "fixture/object.bin");
    const received: Buffer[] = [];
    for await (const chunk of stream) received.push(Buffer.from(chunk));
    expect(Buffer.concat(received)).toEqual(bytes);
  });

  it("rejects traversal keys", async () => {
    const storage = await adapter();
    await expect(storage.head("private-incoming", "../outside")).rejects.toBeInstanceOf(
      StorageKeyError,
    );
  });

  it("promotes to a separate scope without deleting the source", async () => {
    const storage = await adapter();
    const bytes = Buffer.from("synthetic variant");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await storage.put("private-incoming", Readable.from(bytes), "variant.bin", {
      byteSize: bytes.length,
      contentType: "application/octet-stream",
      sha256,
    });
    await storage.promote("private-incoming", "variant.bin", "private-originals", "variant.bin");

    expect(await storage.head("private-incoming", "variant.bin")).not.toBeNull();
    expect(await storage.head("private-originals", "variant.bin")).not.toBeNull();
  });
});
