import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const executableExtensions = new Set([".py", ".sh"]);

export function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedPath(root, path) {
  const result = relative(root, path).split(sep).join("/");
  if (!result || result.startsWith("../") || result.includes("/../")) {
    throw new Error(`Unsafe shared-infrastructure path: ${path}`);
  }
  return result;
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".env.development.local") continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are forbidden in payload input: ${path}`);
    if (entry.isDirectory()) nested.push(...(await collectFiles(path)));
    else if (entry.isFile()) nested.push(path);
    else throw new Error(`Non-regular payload input is forbidden: ${path}`);
  }
  return nested;
}

function tarString(buffer, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) throw new Error(`Tar field is too long: ${value}`);
  encoded.copy(buffer, offset);
}

function tarOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  tarString(buffer, offset, length, `${encoded}\0`);
}

function tarHeader(path, size, mode) {
  if (Buffer.byteLength(path) > 100) {
    throw new Error(`Payload path exceeds the deterministic ustar limit: ${path}`);
  }
  const header = Buffer.alloc(512);
  tarString(header, 0, 100, path);
  tarOctal(header, 100, 8, mode);
  tarOctal(header, 108, 8, 0);
  tarOctal(header, 116, 8, 0);
  tarOctal(header, 124, 12, size);
  tarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  tarString(header, 257, 6, "ustar\0");
  tarString(header, 263, 2, "00");
  tarString(header, 265, 32, "root");
  tarString(header, 297, 32, "root");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  tarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

export function makeDeterministicTar(entries) {
  const chunks = [];
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    chunks.push(tarHeader(entry.path, entry.bytes.length, entry.mode));
    chunks.push(entry.bytes);
    const padding = (512 - (entry.bytes.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

export function inspectTar(buffer) {
  const entries = [];
  const seen = new Set();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const path = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const type = String.fromCharCode(header[156] || 48);
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(`Unsafe archive path: ${path || "<empty>"}`);
    }
    if (type !== "0" && type !== "\0") throw new Error(`Unsafe archive entry type: ${path}`);
    if (seen.has(path)) throw new Error(`Duplicate archive path: ${path}`);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > buffer.length) {
      throw new Error(`Invalid archive size: ${path}`);
    }
    seen.add(path);
    const bytes = buffer.subarray(offset + 512, offset + 512 + size);
    entries.push({ bytes, path, size });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export async function buildSharedInfrastructurePayload(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const infraRoot = join(root, "infra");
  const paths = (await collectFiles(infraRoot)).filter((path) => {
    const logical = normalizedPath(root, path);
    return !logical.startsWith("infra/release/fixtures/");
  });

  const sourceEntries = [];
  for (const path of paths) {
    const logical = normalizedPath(root, path);
    const bytes = await readFile(path);
    const extension = logical.slice(logical.lastIndexOf("."));
    const mode =
      executableExtensions.has(extension) || logical.includes("/scripts/") ? 0o755 : 0o644;
    sourceEntries.push({ bytes, mode, path: logical });
  }

  const inventory = {
    files: sourceEntries.map((entry) => ({
      mode: entry.mode.toString(8).padStart(4, "0"),
      path: entry.path,
      sha256: `sha256:${hash(entry.bytes)}`,
      size: entry.bytes.length,
    })),
    normalized: {
      gid: 0,
      mtime: 0,
      order: "path-byte-order",
      uid: 0,
    },
    schema_version: 1,
  };
  const inventoryBytes = Buffer.from(`${canonical(inventory)}\n`, "utf8");
  const entries = [
    ...sourceEntries,
    { bytes: inventoryBytes, mode: 0o644, path: "payload-inventory.json" },
  ];
  const bytes = makeDeterministicTar(entries);
  return {
    bytes,
    digest: `sha256:${hash(bytes)}`,
    inventory,
    inventoryDigest: `sha256:${hash(inventoryBytes)}`,
  };
}

export async function writeSharedInfrastructurePayload(repositoryRoot, outputRoot) {
  const payload = await buildSharedInfrastructurePayload(repositoryRoot);
  await mkdir(outputRoot, { mode: 0o700, recursive: true });
  const archivePath = join(outputRoot, "esmii-shared-infrastructure.tar");
  const inventoryPath = join(outputRoot, "esmii-shared-infrastructure.inventory.json");
  for (const [path, bytes, mode] of [
    [archivePath, payload.bytes, 0o600],
    [inventoryPath, Buffer.from(`${canonical(payload.inventory)}\n`), 0o600],
  ]) {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx", mode });
    await rename(temporary, path);
    await chmod(path, mode);
    await rm(temporary, { force: true });
  }
  return { ...payload, archivePath, inventoryPath };
}
