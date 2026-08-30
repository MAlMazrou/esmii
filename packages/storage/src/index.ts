import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type StorageScope =
  | "public-variants"
  | "private-incoming"
  | "private-originals"
  | "private-variants"
  | "private-trash";

export interface StorageMetadata {
  byteSize: number;
  contentType: string;
  sha256: string;
}

export interface StoredObjectHead extends StorageMetadata {
  key: string;
  scope: StorageScope;
}

export interface ByteRange {
  endInclusive?: number;
  start: number;
}

export interface TemporaryDownload {
  expiresAt: Date;
  url: URL;
}

export interface StorageAdapter {
  createTemporaryDownload(
    scope: StorageScope,
    key: string,
    expiresAt: Date,
  ): Promise<TemporaryDownload>;
  delete(scope: StorageScope, key: string): Promise<void>;
  head(scope: StorageScope, key: string): Promise<StoredObjectHead | null>;
  openReadStream(scope: StorageScope, key: string, range?: ByteRange): Promise<Readable>;
  promote(
    sourceScope: StorageScope,
    sourceKey: string,
    destinationScope: StorageScope,
    destinationKey: string,
  ): Promise<void>;
  put(scope: StorageScope, stream: Readable, key: string, metadata: StorageMetadata): Promise<void>;
}

export class StorageNotConfiguredError extends Error {
  public constructor() {
    super("Storage is not configured for this runtime");
    this.name = "StorageNotConfiguredError";
  }
}

export class StorageIntegrityError extends Error {
  public constructor(reason: string) {
    super(`Storage integrity check failed: ${reason}`);
    this.name = "StorageIntegrityError";
  }
}

export class StorageKeyError extends Error {
  public constructor() {
    super("Storage key is invalid");
    this.name = "StorageKeyError";
  }
}

function validateKey(key: string): string {
  if (
    key.length < 1 ||
    key.length > 1024 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.includes("\0") ||
    key.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new StorageKeyError();
  }
  return key;
}

function validateMetadata(metadata: StorageMetadata): void {
  if (!Number.isSafeInteger(metadata.byteSize) || metadata.byteSize < 0) {
    throw new StorageIntegrityError("byte size is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(metadata.sha256)) {
    throw new StorageIntegrityError("SHA-256 is invalid");
  }
  if (metadata.contentType.length < 1 || metadata.contentType.length > 255) {
    throw new StorageIntegrityError("content type is invalid");
  }
}

export interface FilesystemStorageRoots {
  "private-incoming": string;
  "private-originals": string;
  "private-trash": string;
  "private-variants": string;
  "public-variants": string;
}

export interface FilesystemStorageAdapterOptions {
  roots: FilesystemStorageRoots;
  temporaryDownloadUrl: (input: { expiresAt: Date; key: string; scope: StorageScope }) => URL;
}

export class FilesystemStorageAdapter implements StorageAdapter {
  readonly #roots: FilesystemStorageRoots;
  readonly #temporaryDownloadUrl: FilesystemStorageAdapterOptions["temporaryDownloadUrl"];

  public constructor(options: FilesystemStorageAdapterOptions) {
    this.#roots = Object.fromEntries(
      Object.entries(options.roots).map(([scope, root]) => [scope, resolve(root)]),
    ) as unknown as FilesystemStorageRoots;
    this.#temporaryDownloadUrl = options.temporaryDownloadUrl;
  }

  #path(scope: StorageScope, key: string): string {
    const root = this.#roots[scope];
    const path = resolve(join(root, validateKey(key)));
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new StorageKeyError();
    return path;
  }

  public async createTemporaryDownload(
    scope: StorageScope,
    key: string,
    expiresAt: Date,
  ): Promise<TemporaryDownload> {
    validateKey(key);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new TypeError("expiresAt must be a future date");
    }
    if ((await this.head(scope, key)) === null)
      throw new StorageIntegrityError("object is missing");
    return {
      expiresAt: new Date(expiresAt),
      url: this.#temporaryDownloadUrl({ scope, key, expiresAt }),
    };
  }

  public async delete(scope: StorageScope, key: string): Promise<void> {
    await rm(this.#path(scope, key), { force: true });
  }

  public async head(scope: StorageScope, key: string): Promise<StoredObjectHead | null> {
    const path = this.#path(scope, key);
    let information;
    try {
      information = await lstat(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    if (!information.isFile() || information.isSymbolicLink()) {
      throw new StorageIntegrityError("object is not a regular file");
    }
    const metadataPath = `${path}.metadata.json`;
    let metadata: StorageMetadata;
    try {
      const handle = await open(metadataPath, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
      try {
        metadata = JSON.parse(await handle.readFile("utf8")) as StorageMetadata;
      } finally {
        await handle.close();
      }
    } catch {
      throw new StorageIntegrityError("metadata is missing or invalid");
    }
    validateMetadata(metadata);
    if (metadata.byteSize !== information.size) {
      throw new StorageIntegrityError("stored byte size does not match metadata");
    }
    return { ...metadata, key, scope };
  }

  public async openReadStream(
    scope: StorageScope,
    key: string,
    range?: ByteRange,
  ): Promise<Readable> {
    const path = this.#path(scope, key);
    if (range !== undefined) {
      if (
        !Number.isSafeInteger(range.start) ||
        range.start < 0 ||
        (range.endInclusive !== undefined &&
          (!Number.isSafeInteger(range.endInclusive) || range.endInclusive < range.start))
      ) {
        throw new RangeError("Storage byte range is invalid");
      }
    }
    const handle = await open(path, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
    const information = await handle.stat();
    if (!information.isFile()) {
      await handle.close();
      throw new StorageIntegrityError("object is not a regular file");
    }
    return handle.createReadStream({
      autoClose: true,
      ...(range === undefined ? {} : { start: range.start }),
      ...(range?.endInclusive === undefined ? {} : { end: range.endInclusive }),
    });
  }

  public async promote(
    sourceScope: StorageScope,
    sourceKey: string,
    destinationScope: StorageScope,
    destinationKey: string,
  ): Promise<void> {
    const source = this.#path(sourceScope, sourceKey);
    const destination = this.#path(destinationScope, destinationKey);
    const sourceHead = await this.head(sourceScope, sourceKey);
    if (sourceHead === null) throw new StorageIntegrityError("source object is missing");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination, fileConstants.COPYFILE_EXCL);
    try {
      await copyFile(
        `${source}.metadata.json`,
        `${destination}.metadata.json`,
        fileConstants.COPYFILE_EXCL,
      );
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
  }

  public async put(
    scope: StorageScope,
    stream: Readable,
    key: string,
    metadata: StorageMetadata,
  ): Promise<void> {
    validateMetadata(metadata);
    const destination = this.#path(scope, key);
    const temporary = `${destination}.${randomUUID()}.partial`;
    const temporaryMetadata = `${temporary}.metadata.json`;
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });

    let byteSize = 0;
    const digest = createHash("sha256");
    const verifier = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += chunk.byteLength;
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(stream, verifier, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      const syncHandle = await open(temporary, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
      try {
        await syncHandle.sync();
      } finally {
        await syncHandle.close();
      }
      if (byteSize !== metadata.byteSize || digest.digest("hex") !== metadata.sha256) {
        throw new StorageIntegrityError("stream does not match declared metadata");
      }
      const metadataHandle = await open(
        temporaryMetadata,
        fileConstants.O_CREAT |
          fileConstants.O_EXCL |
          fileConstants.O_WRONLY |
          fileConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await metadataHandle.writeFile(JSON.stringify(metadata));
        await metadataHandle.sync();
      } finally {
        await metadataHandle.close();
      }
      await rename(temporary, destination);
      await rename(temporaryMetadata, `${destination}.metadata.json`);
    } finally {
      await rm(temporary, { force: true });
      await rm(temporaryMetadata, { force: true });
    }
  }
}

export interface S3ObjectClient {
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  delete(key: string): Promise<void>;
  get(key: string, range?: ByteRange): Promise<Readable>;
  head(key: string): Promise<StorageMetadata | null>;
  presignGet(key: string, expiresAt: Date): Promise<URL>;
  put(key: string, stream: Readable, metadata: StorageMetadata): Promise<void>;
}

/** Provider-neutral S3 seam; selecting or configuring an S3 provider is deferred. */
export class S3StorageAdapter implements StorageAdapter {
  readonly #client: S3ObjectClient;
  readonly #environmentPrefix: string;

  public constructor(client: S3ObjectClient, environmentPrefix: string) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(environmentPrefix)) {
      throw new TypeError("environmentPrefix is invalid");
    }
    this.#client = client;
    this.#environmentPrefix = environmentPrefix;
  }

  #key(scope: StorageScope, key: string): string {
    return `${this.#environmentPrefix}/${scope}/${validateKey(key)}`;
  }

  public async createTemporaryDownload(scope: StorageScope, key: string, expiresAt: Date) {
    return {
      expiresAt: new Date(expiresAt),
      url: await this.#client.presignGet(this.#key(scope, key), expiresAt),
    };
  }

  public async delete(scope: StorageScope, key: string): Promise<void> {
    await this.#client.delete(this.#key(scope, key));
  }

  public async head(scope: StorageScope, key: string): Promise<StoredObjectHead | null> {
    const metadata = await this.#client.head(this.#key(scope, key));
    return metadata === null ? null : { ...metadata, key, scope };
  }

  public async openReadStream(
    scope: StorageScope,
    key: string,
    range?: ByteRange,
  ): Promise<Readable> {
    return this.#client.get(this.#key(scope, key), range);
  }

  public async promote(
    sourceScope: StorageScope,
    sourceKey: string,
    destinationScope: StorageScope,
    destinationKey: string,
  ): Promise<void> {
    await this.#client.copy(
      this.#key(sourceScope, sourceKey),
      this.#key(destinationScope, destinationKey),
    );
  }

  public async put(
    scope: StorageScope,
    stream: Readable,
    key: string,
    metadata: StorageMetadata,
  ): Promise<void> {
    validateMetadata(metadata);
    await this.#client.put(this.#key(scope, key), stream, metadata);
  }
}
