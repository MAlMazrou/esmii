import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonical, hash, makeDeterministicTar } from "./infra/payload.mjs";

const sourceShaPattern = /^[0-9a-f]{40}$/u;
const migrationPattern = /^\d{4}_[a-z0-9_]+$/u;
const imagePatterns = {
  server: /^ghcr\.io\/malmazrou\/esmii-server@sha256:[0-9a-f]{64}$/u,
  web: /^ghcr\.io\/malmazrou\/esmii-web@sha256:[0-9a-f]{64}$/u,
};

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys differ from the release contract.`);
  }
}

function canonicalBytes(value) {
  return Buffer.from(`${canonical(value)}\n`, "utf8");
}

function digest(value) {
  return `sha256:${hash(value)}`;
}

function inside(root, path, label) {
  const result = relative(root, path);
  if (
    !result ||
    result === ".." ||
    result.startsWith(`..${sep}`) ||
    resolve(root, result) !== path
  ) {
    throw new Error(`${label} must resolve to a regular file below its approved root.`);
  }
}

async function readRegularFile(root, logicalPath, label) {
  if (typeof logicalPath !== "string" || logicalPath.length === 0) {
    throw new Error(`${label} path is required.`);
  }
  const path = resolve(root, logicalPath);
  inside(root, path, label);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
  return readFile(path);
}

async function collectRegularFiles(root, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Migration inventory contains a symlink: ${path}`);
    if (entry.isDirectory()) paths.push(...(await collectRegularFiles(root, path)));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Migration inventory contains a non-regular entry: ${path}`);
  }
  return paths.map((path) => relative(root, path).split(sep).join("/")).sort();
}

function inventoryEntry(kind, path, bytes) {
  return { kind, path, sha256: digest(bytes), size: bytes.length };
}

function comparePath(left, right) {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

function validateInput(input) {
  exactKeys(
    input,
    ["files", "migration", "schema_version", "server_image", "source_sha", "web_image"],
    "Application-payload input",
  );
  exactKeys(input.files, ["evidence", "provenance", "server_sbom", "web_sbom"], "Artifact files");
  exactKeys(input.migration, ["from", "to"], "Migration transition");
  if (input.schema_version !== 1) throw new Error("Unsupported application-payload input schema.");
  if (!sourceShaPattern.test(input.source_sha))
    throw new Error("Source SHA must be one full lowercase Git SHA.");
  if (!imagePatterns.web.test(input.web_image) || !imagePatterns.server.test(input.server_image)) {
    throw new Error("Application images must be immutable Esmii GHCR digests.");
  }
  if (
    (input.migration.from !== "empty" && !migrationPattern.test(input.migration.from)) ||
    !migrationPattern.test(input.migration.to)
  ) {
    throw new Error("Migration transition identifiers are invalid.");
  }
}

async function migrationInventory(repositoryRoot, transition) {
  const migrationRoot = join(repositoryRoot, "packages", "database", "migrations");
  const paths = await collectRegularFiles(repositoryRoot, migrationRoot);
  const sqlIdentifiers = new Set(
    paths
      .filter((path) => path.endsWith(".sql"))
      .map((path) => path.slice(path.lastIndexOf("/") + 1, -4)),
  );
  if (!sqlIdentifiers.has(transition.to)) {
    throw new Error(`Target migration is absent: ${transition.to}`);
  }
  if (transition.from !== "empty" && !sqlIdentifiers.has(transition.from)) {
    throw new Error(`Source migration is absent: ${transition.from}`);
  }

  const entries = [];
  for (const path of paths) {
    entries.push(inventoryEntry("migration", path, await readFile(join(repositoryRoot, path))));
  }
  return entries;
}

function tarInventory(entries) {
  return {
    files: entries.map((entry) => ({
      mode: entry.mode.toString(8).padStart(4, "0"),
      path: entry.path,
      sha256: digest(entry.bytes),
      size: entry.bytes.length,
    })),
    normalized: { gid: 0, mtime: 0, order: "path-byte-order", uid: 0 },
    schema_version: 1,
  };
}

export async function buildApplicationPayload(repositoryRoot, artifactRoot, input) {
  const repository = resolve(repositoryRoot);
  const artifacts = resolve(artifactRoot);
  validateInput(input);

  const [lockfile, webSbom, serverSbom, provenance, evidence, migrations] = await Promise.all([
    readRegularFile(repository, "pnpm-lock.yaml", "Dependency lockfile"),
    readRegularFile(artifacts, input.files.web_sbom, "Web SBOM"),
    readRegularFile(artifacts, input.files.server_sbom, "Server SBOM"),
    readRegularFile(artifacts, input.files.provenance, "Provenance record"),
    readRegularFile(artifacts, input.files.evidence, "CI evidence record"),
    migrationInventory(repository, input.migration),
  ]);

  const inventory = [
    inventoryEntry("dependency-lock", "pnpm-lock.yaml", lockfile),
    ...migrations,
    inventoryEntry("sbom", "sbom-server.spdx.json", serverSbom),
    inventoryEntry("sbom", "sbom-web.spdx.json", webSbom),
  ].sort(comparePath);

  const metadata = {
    evidence_digest: digest(evidence),
    inventory,
    migration: input.migration,
    provenance_digest: digest(provenance),
    schema_version: 1,
    server_image: input.server_image,
    source_sha: input.source_sha,
    web_image: input.web_image,
  };
  const metadataBytes = canonicalBytes(metadata);
  const sourceEntries = [{ bytes: metadataBytes, mode: 0o644, path: "application-payload.json" }];
  const payloadInventory = tarInventory(sourceEntries);
  const payloadInventoryBytes = canonicalBytes(payloadInventory);
  const bytes = makeDeterministicTar([
    ...sourceEntries,
    { bytes: payloadInventoryBytes, mode: 0o644, path: "payload-inventory.json" },
  ]);

  return {
    bytes,
    digest: digest(bytes),
    metadata,
    metadataDigest: digest(metadataBytes),
    payloadInventory,
  };
}

async function atomicWrite(path, bytes, mode) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode });
  await rename(temporary, path);
  await chmod(path, mode);
  await rm(temporary, { force: true });
}

export async function writeApplicationPayload(repositoryRoot, artifactRoot, input, outputRoot) {
  const payload = await buildApplicationPayload(repositoryRoot, artifactRoot, input);
  await mkdir(outputRoot, { mode: 0o700, recursive: true });
  const archivePath = join(outputRoot, "esmii-application-payload.tar");
  const metadataPath = join(outputRoot, "esmii-application-payload.json");
  await atomicWrite(archivePath, payload.bytes, 0o600);
  await atomicWrite(metadataPath, canonicalBytes(payload.metadata), 0o600);
  return { ...payload, archivePath, metadataPath };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath) {
  const repositoryRoot = resolve(dirname(modulePath), "..");
  const inputPath = option("--input");
  if (inputPath === undefined) {
    console.error(
      "Usage: application-payload.mjs --input <candidate.json> [--artifact-root <dir>] [--output <dir>]",
    );
    process.exit(1);
  }

  try {
    const resolvedInput = resolve(inputPath);
    const input = JSON.parse(await readFile(resolvedInput, "utf8"));
    const artifactRoot = resolve(option("--artifact-root") ?? dirname(resolvedInput));
    const outputRoot = resolve(
      option("--output") ?? join(repositoryRoot, ".local", "prompt05", "application-payload"),
    );
    const payload = await writeApplicationPayload(repositoryRoot, artifactRoot, input, outputRoot);
    console.log(
      JSON.stringify({
        archive: payload.archivePath,
        digest: payload.digest,
        inventory_entries: payload.metadata.inventory.length,
        metadata: payload.metadataPath,
        metadata_digest: payload.metadataDigest,
        source_sha: payload.metadata.source_sha,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
