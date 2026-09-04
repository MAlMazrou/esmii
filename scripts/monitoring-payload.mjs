#!/usr/bin/env node

import { join, resolve } from "node:path";

import { repositoryRoot } from "./infra/core.mjs";
import {
  buildMonitoringHostPayload,
  inspectTar,
  writeMonitoringHostPayload,
} from "./infra/payload.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const command = process.argv[2];
const revision = option("--revision");
const output = resolve(
  option("--output") ?? join(repositoryRoot, ".local", "prompt07", "monitoring-host-payload"),
);

try {
  if (!revision) throw new Error("--revision is required.");
  if (command === "build") {
    const payload = await writeMonitoringHostPayload(repositoryRoot, output, revision);
    inspectTar(payload.bytes);
    console.log(
      JSON.stringify({
        archive: payload.archivePath,
        bootstrap: payload.bootstrapPath,
        bootstrap_sha256: payload.bootstrapDigest,
        digest: payload.digest,
        files: payload.inventory.files.length,
        inventory_digest: payload.inventoryDigest,
        metadata: payload.metadataPath,
        source_revision: payload.metadata.source_revision,
        verifier: payload.verifierPath,
        verifier_sha256: payload.verifierDigest,
      }),
    );
  } else if (command === "verify") {
    const first = await buildMonitoringHostPayload(repositoryRoot, revision);
    const second = await buildMonitoringHostPayload(repositoryRoot, revision);
    if (!first.bytes.equals(second.bytes)) {
      throw new Error("Deterministic monitoring host payload rebuild differed.");
    }
    inspectTar(first.bytes);
    console.log(`Monitoring host payload is deterministic: ${first.digest}`);
  } else {
    throw new Error(
      "Usage: monitoring-payload.mjs build|verify --revision <full-sha> [--output <directory>]",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
