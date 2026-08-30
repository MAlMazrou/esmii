import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  fixturesRoot,
  readFixtureManifest,
  renderFixture,
  repositoryRoot,
  runCaddyValidation,
  runComposeValidation,
  validateSourceTemplates,
  validateStalwartToml,
} from "./infra/core.mjs";
import {
  buildSharedInfrastructurePayload,
  inspectTar,
  writeSharedInfrastructurePayload,
} from "./infra/payload.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fixtureName() {
  const fixture = option("--fixture");
  if (!fixture) throw new Error("A --fixture value is required.");
  return fixture;
}

const command = process.argv[2];
const localRoot = join(repositoryRoot, ".local", "prompt04");

try {
  if (command === "validate-templates") {
    const result = await validateSourceTemplates();
    for (const fixture of ["staging", "production-restricted", "production-public"]) {
      await readFixtureManifest(fixture);
    }
    console.log(
      `Validated ${result.templates} source templates, ${result.schemas} closed schemas, and 3 canonical manifests.`,
    );
  } else if (command === "render") {
    const fixture = fixtureName();
    const output = resolve(option("--output") ?? join(localRoot, "rendered", fixture));
    const rendered = await renderFixture(fixture, output);
    const compose = runComposeValidation(rendered);
    await validateStalwartToml(rendered);
    console.log(
      JSON.stringify({
        fixture,
        output,
        rendered_compose_digest: rendered.renderedComposeDigest,
        services: compose.services,
      }),
    );
  } else if (command === "caddy") {
    const fixture = fixtureName();
    const output = resolve(join(localRoot, "rendered", fixture));
    const rendered = await renderFixture(fixture, output);
    runComposeValidation(rendered);
    runCaddyValidation(rendered);
    console.log(`Caddy accepted the sealed ${fixture} fixture.`);
  } else if (command === "build-payload") {
    const output = resolve(option("--output") ?? join(localRoot, "payload"));
    const payload = await writeSharedInfrastructurePayload(repositoryRoot, output);
    inspectTar(payload.bytes);
    console.log(
      JSON.stringify({
        archive: payload.archivePath,
        digest: payload.digest,
        files: payload.inventory.files.length,
        inventory_digest: payload.inventoryDigest,
      }),
    );
  } else if (command === "print-digests") {
    await mkdir(join(localRoot, "digest-preview"), { recursive: true, mode: 0o700 });
    const payload = await buildSharedInfrastructurePayload(repositoryRoot);
    const fixtures = {};
    for (const fixture of ["staging", "production-restricted", "production-public"]) {
      const rendered = await renderFixture(fixture, join(localRoot, "digest-preview", fixture), {
        verifyDigest: false,
      });
      fixtures[fixture] = {
        edge_fragment_digest: rendered.edgeFragmentDigest,
        rendered_compose_digest: rendered.renderedComposeDigest,
        shared_config_digest: rendered.sharedConfigDigest,
      };
    }
    console.log(JSON.stringify({ fixtures, shared_payload_digest: payload.digest }, null, 2));
  } else if (command === "verify-payload") {
    const first = await buildSharedInfrastructurePayload(repositoryRoot);
    const second = await buildSharedInfrastructurePayload(repositoryRoot);
    if (!first.bytes.equals(second.bytes))
      throw new Error("Deterministic payload rebuild differed.");
    inspectTar(first.bytes);
    console.log(`Shared-infrastructure payload is deterministic: ${first.digest}`);
  } else {
    throw new Error(
      "Usage: infra.mjs <validate-templates|render|caddy|build-payload|print-digests|verify-payload>",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

void fixturesRoot;
