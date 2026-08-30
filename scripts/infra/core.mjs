import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createLocalDockerInvocation,
  formatLocalDockerCommand,
  spawnLocalDocker,
} from "../local-docker.mjs";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const fixturesRoot = join(repositoryRoot, "infra", "release", "fixtures");
export const caddyImage =
  "caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const imagePattern = /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/u;
const sourcePattern = /^[0-9a-f]{40}$/u;
const unresolvedPattern = /@@[A-Z0-9_]+@@|\$\{[^}]+\}|<[A-Z][A-Z0-9_]*>/u;

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fail(message) {
  throw new Error(`Prompt 04 infrastructure validation failed: ${message}`);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (extras.length > 0 || missing.length > 0) {
    fail(
      `${label} keys differ (extra: ${extras.join(",") || "none"}; missing: ${missing.join(",") || "none"})`,
    );
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    fail(`${label} must be a non-empty canonical string`);
  }
  return value;
}

function digest(value, label) {
  if (!digestPattern.test(value)) fail(`${label} must be an immutable sha256 digest`);
}

function validateCidrs(values, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) fail(`${label} is invalid`);
  for (const value of values) {
    if (
      typeof value !== "string" ||
      !/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/u.test(value)
    ) {
      fail(`${label} contains an invalid IPv4 CIDR`);
    }
    const [address] = value.split("/");
    if (address.split(".").some((part) => Number(part) > 255)) fail(`${label} is out of range`);
  }
}

function ipv4Number(value) {
  const parts = value.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    fail(`invalid IPv4 address: ${value}`);
  }
  return parts.reduce((result, part) => (result * 256 + part) >>> 0, 0) >>> 0;
}

function validateAddressInSubnet(address, subnet, label) {
  const [network, prefixText] = subnet.split("/");
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) fail(`${label} subnet is invalid`);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const networkNumber = ipv4Number(network);
  const addressNumber = ipv4Number(address);
  if (
    (networkNumber & mask) >>> 0 !== networkNumber ||
    (addressNumber & mask) >>> 0 !== networkNumber
  ) {
    fail(`${label} address is not inside its canonical subnet`);
  }
  const broadcast = (networkNumber | (~mask >>> 0)) >>> 0;
  if (addressNumber === networkNumber || addressNumber === broadcast) {
    fail(`${label} address cannot be the network or broadcast address`);
  }
}

function validateEnvironment(environment, name) {
  const common = [
    "sealed_input_record_id",
    "sealed_input_record_mac",
    "application_payload_digest",
    "source_sha",
    "app_domain",
    "admin_health_cidrs",
    "edge_subnet",
    "caddy_ip",
    "web_image",
    "server_image",
    "schema_transition",
    "config_digest",
    "ci_evidence_digest",
  ];
  const productionOnly = [
    "mail_domain",
    "mail_hostname",
    "bounce_domain",
    "production_mail_admin_subnet",
    "stalwart_mail_admin_ip",
    "mail_mode",
    "mail_config_digest",
    "mail_evidence_digest",
    "edge_mode",
    "edge_fragment_digest",
    "prelaunch_test_cidrs",
    "prelaunch_test_cidrs_digest",
  ];
  exactKeys(environment, name === "production" ? [...common, ...productionOnly] : common, name);
  nonEmptyString(environment.sealed_input_record_id, `${name}.sealed_input_record_id`);
  if (!/^hmac-sha256:[0-9a-f]{64}$/u.test(environment.sealed_input_record_mac)) {
    fail(`${name}.sealed_input_record_mac is invalid`);
  }
  digest(environment.application_payload_digest, `${name}.application_payload_digest`);
  if (!sourcePattern.test(environment.source_sha)) fail(`${name}.source_sha is invalid`);
  if (!/^[a-z0-9.-]+$/u.test(environment.app_domain) || !environment.app_domain.includes(".")) {
    fail(`${name}.app_domain is invalid`);
  }
  validateCidrs(environment.admin_health_cidrs, `${name}.admin_health_cidrs`);
  validateAddressInSubnet(environment.caddy_ip, environment.edge_subnet, `${name}.edge`);
  if (!imagePattern.test(environment.web_image) || !imagePattern.test(environment.server_image)) {
    fail(`${name} application images must be registry digests`);
  }
  const schema = plainObject(environment.schema_transition, `${name}.schema_transition`);
  exactKeys(schema, ["from", "to"], `${name}.schema_transition`);
  nonEmptyString(schema.from, `${name}.schema_transition.from`);
  nonEmptyString(schema.to, `${name}.schema_transition.to`);
  digest(environment.config_digest, `${name}.config_digest`);
  digest(environment.ci_evidence_digest, `${name}.ci_evidence_digest`);

  if (name === "production") {
    for (const key of ["mail_domain", "mail_hostname", "bounce_domain"]) {
      if (!/^[a-z0-9.-]+$/u.test(environment[key]) || !environment[key].includes(".")) {
        fail(`production.${key} is invalid`);
      }
    }
    validateAddressInSubnet(
      environment.stalwart_mail_admin_ip,
      environment.production_mail_admin_subnet,
      "production.mail_admin",
    );
    if (environment.edge_subnet === environment.production_mail_admin_subnet) {
      fail("production edge and mail-admin subnets collide");
    }
    if (!["private", "external"].includes(environment.mail_mode))
      fail("production.mail_mode is invalid");
    digest(environment.mail_config_digest, "production.mail_config_digest");
    if (environment.mail_evidence_digest !== null) {
      digest(environment.mail_evidence_digest, "production.mail_evidence_digest");
    }
    if (!["restricted", "public"].includes(environment.edge_mode))
      fail("production.edge_mode is invalid");
    digest(environment.edge_fragment_digest, "production.edge_fragment_digest");
    validateCidrs(environment.prelaunch_test_cidrs, "production.prelaunch_test_cidrs", {
      allowEmpty: environment.edge_mode === "public",
    });
    if (environment.edge_mode === "restricted") {
      if (environment.prelaunch_test_cidrs.length === 0) fail("restricted production needs CIDRs");
      digest(environment.prelaunch_test_cidrs_digest, "production.prelaunch_test_cidrs_digest");
    } else if (
      environment.prelaunch_test_cidrs.length !== 0 ||
      environment.prelaunch_test_cidrs_digest !== null
    ) {
      fail("public production must clear its prelaunch CIDR set");
    }
  }
}

export function validateActivationManifest(manifest) {
  plainObject(manifest, "manifest");
  exactKeys(
    manifest,
    [
      "schema_version",
      "release_id",
      "previous_release_id",
      "previous_activation_manifest_digest",
      "deployment_epoch",
      "deployment_sequence",
      "compose_project",
      "infrastructure_sha",
      "shared_infrastructure_payload_digest",
      "certificate_contact",
      "active_compose_files",
      "rendered_compose_digest",
      "change_targets",
      "shared_config_digest",
      "promotion_source_checkpoint_digest",
      "environments",
    ],
    "manifest",
  );
  if (manifest.schema_version !== 1) fail("manifest schema_version must be 1");
  nonEmptyString(manifest.release_id, "release_id");
  if (manifest.previous_release_id !== null)
    nonEmptyString(manifest.previous_release_id, "previous_release_id");
  if (manifest.previous_activation_manifest_digest !== null) {
    digest(manifest.previous_activation_manifest_digest, "previous_activation_manifest_digest");
  }
  nonEmptyString(manifest.deployment_epoch, "deployment_epoch");
  if (!Number.isSafeInteger(manifest.deployment_sequence) || manifest.deployment_sequence < 1) {
    fail("deployment_sequence must be a positive integer");
  }
  if (manifest.compose_project !== "esmii-host") fail("compose_project must be esmii-host");
  if (!sourcePattern.test(manifest.infrastructure_sha)) fail("infrastructure_sha is invalid");
  digest(manifest.shared_infrastructure_payload_digest, "shared_infrastructure_payload_digest");
  if (!/^[^@\s]+@[^@\s]+$/u.test(manifest.certificate_contact))
    fail("certificate_contact is invalid");
  const files = manifest.active_compose_files;
  const expectedStaging = ["infra/compose.yaml", "infra/compose.staging.yaml"];
  const expectedFull = [...expectedStaging, "infra/compose.production.yaml"];
  if (
    !Array.isArray(files) ||
    ![expectedStaging, expectedFull].some(
      (expected) =>
        expected.length === files.length && expected.every((file, index) => file === files[index]),
    )
  ) {
    fail("active_compose_files is not an approved ordered overlay set");
  }
  digest(manifest.rendered_compose_digest, "rendered_compose_digest");
  if (!Array.isArray(manifest.change_targets) || manifest.change_targets.length === 0) {
    fail("change_targets is invalid");
  }
  const allowedTargets = new Set([
    "staging",
    "production",
    "shared-infrastructure",
    "production-mail",
    "public-edge",
    "rollback",
  ]);
  if (manifest.change_targets.some((target) => !allowedTargets.has(target)))
    fail("change_targets is invalid");
  digest(manifest.shared_config_digest, "shared_config_digest");
  if (manifest.promotion_source_checkpoint_digest !== null) {
    digest(manifest.promotion_source_checkpoint_digest, "promotion_source_checkpoint_digest");
  }
  const environments = plainObject(manifest.environments, "environments");
  exactKeys(environments, ["staging", "production"], "environments");
  validateEnvironment(plainObject(environments.staging, "staging"), "staging");
  if (environments.production === null) {
    if (files.length !== 2) fail("a staging-only manifest must not activate production overlays");
    if (manifest.promotion_source_checkpoint_digest !== null) {
      fail("staging-only manifest cannot claim production promotion evidence");
    }
  } else {
    if (files.length !== 3) fail("production requires base+staging+production");
    validateEnvironment(plainObject(environments.production, "production"), "production");
    digest(manifest.promotion_source_checkpoint_digest, "promotion_source_checkpoint_digest");
  }
  return manifest;
}

export async function readFixtureManifest(fixture) {
  if (!["staging", "production-restricted", "production-public"].includes(fixture)) {
    fail(`unknown fixture: ${fixture}`);
  }
  const path = join(fixturesRoot, fixture, "release.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(
      `fixture manifest is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const canonical = `${canonicalJson(parsed)}\n`;
  if ((await readFile(path, "utf8")) !== canonical) fail(`${fixture} manifest is not canonical`);
  return validateActivationManifest(parsed);
}

function tokensForManifest(manifest) {
  const staging = manifest.environments.staging;
  const tokens = {
    CERTIFICATE_CONTACT: manifest.certificate_contact,
    STAGING_ADMIN_HEALTH_CIDRS: staging.admin_health_cidrs.join(" "),
    STAGING_APP_DOMAIN: staging.app_domain,
    STAGING_CADDY_IP: staging.caddy_ip,
    STAGING_EDGE_SUBNET: staging.edge_subnet,
    STAGING_SERVER_IMAGE: staging.server_image,
    STAGING_WEB_IMAGE: staging.web_image,
  };
  const production = manifest.environments.production;
  if (production !== null) {
    Object.assign(tokens, {
      BOUNCE_DOMAIN: production.bounce_domain,
      MAIL_DOMAIN: production.mail_domain,
      MAIL_HOSTNAME: production.mail_hostname,
      PRODUCTION_ADMIN_HEALTH_CIDRS: production.admin_health_cidrs.join(" "),
      PRODUCTION_APP_DOMAIN: production.app_domain,
      PRODUCTION_CADDY_IP: production.caddy_ip,
      PRODUCTION_EDGE_SUBNET: production.edge_subnet,
      PRODUCTION_MAIL_ADMIN_SUBNET: production.production_mail_admin_subnet,
      PRODUCTION_MAIL_PORTS_BLOCK:
        production.mail_mode === "external"
          ? [
              "ports:",
              "      - name: public-smtp",
              "        target: 25",
              '        published: "25"',
              "        protocol: tcp",
              "      - name: loopback-imaps",
              "        target: 993",
              '        published: "1993"',
              "        host_ip: 127.0.0.1",
              "        protocol: tcp",
            ].join("\n")
          : "# No host mail ports in private mode.",
      PRODUCTION_PRELAUNCH_TEST_CIDRS: production.prelaunch_test_cidrs.join(" "),
      PRODUCTION_SERVER_IMAGE: production.server_image,
      PRODUCTION_WEB_IMAGE: production.web_image,
      STALWART_MAIL_ADMIN_IP: production.stalwart_mail_admin_ip,
    });
  }
  return tokens;
}

export function renderText(source, tokens, label) {
  const present = new Set([...source.matchAll(/@@([A-Z0-9_]+)@@/gu)].map((match) => match[1]));
  for (const token of present) {
    if (!Object.hasOwn(tokens, token)) fail(`${label} contains an unapproved token ${token}`);
  }
  let rendered = source;
  for (const token of present) rendered = rendered.replaceAll(`@@${token}@@`, tokens[token]);
  if (unresolvedPattern.test(rendered)) fail(`${label} contains an unresolved placeholder`);
  return rendered;
}

async function writeRendered(outputRoot, path, contents, mode = 0o644) {
  const absolute = resolve(outputRoot, path);
  if (!absolute.startsWith(`${resolve(outputRoot)}/`)) fail(`render path escapes output: ${path}`);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  await writeFile(absolute, contents, { mode });
  await chmod(absolute, mode);
  return absolute;
}

async function renderSource(tokens, sourcePath, outputRoot, outputPath = sourcePath) {
  const source = await readFile(join(repositoryRoot, sourcePath), "utf8");
  return writeRendered(outputRoot, outputPath, renderText(source, tokens, sourcePath));
}

export function canonicalComposeDigest(activeFiles, outputRoot) {
  return Promise.all(
    activeFiles.map(async (path) => ({
      bytes: await readFile(join(outputRoot, path)),
      path,
    })),
  ).then((entries) =>
    sha256(
      Buffer.concat(
        entries.flatMap((entry) => [
          Buffer.from(`${entry.path}\0${entry.bytes.length}\0`, "utf8"),
          entry.bytes,
        ]),
      ),
    ),
  );
}

async function configDigest(outputRoot) {
  const files = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && !path.endsWith("compose.yaml") && !path.includes("compose.")) {
        const logical = relative(outputRoot, path).split("/").join("/");
        files.push({ bytes: await readFile(path), path: logical });
      }
    }
  }
  await walk(join(outputRoot, "infra"));
  return sha256(
    Buffer.concat(
      files.flatMap((entry) => [
        Buffer.from(`${entry.path}\0${entry.bytes.length}\0`),
        entry.bytes,
      ]),
    ),
  );
}

export async function renderActivationManifest(
  manifest,
  outputRoot,
  { label = manifest.release_id, verifyDigest = true } = {},
) {
  validateActivationManifest(manifest);
  const root = resolve(outputRoot);
  await rm(root, { force: true, recursive: true });
  await mkdir(root, { mode: 0o700, recursive: true });
  const tokens = tokensForManifest(manifest);

  await renderSource(tokens, "infra/compose.yaml", root);
  await renderSource(tokens, "infra/compose.staging.yaml", root);
  await renderSource(tokens, "infra/caddy/Caddyfile.host", root, "infra/caddy/Caddyfile");
  await renderSource(
    tokens,
    "infra/caddy/sites/staging.caddy",
    root,
    "infra/caddy/sites-enabled/staging.caddy",
  );
  await chmod(join(root, "infra/caddy"), 0o755);
  await chmod(join(root, "infra/caddy/sites-enabled"), 0o755);
  for (const path of [
    "infra/postgres/init-host.sh",
    "infra/postgres/staging.conf",
    "infra/valkey/staging.conf",
  ]) {
    await renderSource(tokens, path, root);
  }

  let edgeFragmentDigest = null;
  if (manifest.environments.production !== null) {
    await renderSource(tokens, "infra/compose.production.yaml", root);
    const source = `infra/caddy/sites/production-${manifest.environments.production.edge_mode}.caddy`;
    const destination = "infra/caddy/sites-enabled/production.caddy";
    const output = await renderSource(tokens, source, root, destination);
    edgeFragmentDigest = sha256(await readFile(output));
    for (const path of [
      "infra/postgres/production.conf",
      "infra/valkey/production.conf",
      "infra/stalwart/config.toml",
    ]) {
      await renderSource(tokens, path, root);
    }
  }

  const renderedComposeDigest = await canonicalComposeDigest(manifest.active_compose_files, root);
  const sharedConfigDigest = await configDigest(root);
  if (verifyDigest && renderedComposeDigest !== manifest.rendered_compose_digest) {
    fail(`rendered Compose digest mismatch for ${label}`);
  }
  if (verifyDigest && sharedConfigDigest !== manifest.shared_config_digest) {
    fail(`shared configuration digest mismatch for ${label}`);
  }
  if (
    verifyDigest &&
    manifest.environments.production !== null &&
    edgeFragmentDigest !== manifest.environments.production.edge_fragment_digest
  ) {
    fail(`production edge fragment digest mismatch for ${label}`);
  }

  const seal = {
    active_compose_files: manifest.active_compose_files,
    activation_manifest_digest: sha256(Buffer.from(`${canonicalJson(manifest)}\n`)),
    edge_fragment_digest: edgeFragmentDigest,
    release_id: manifest.release_id,
    rendered_compose_digest: renderedComposeDigest,
    shared_config_digest: sharedConfigDigest,
  };
  await writeRendered(root, "seal.json", `${canonicalJson(seal)}\n`, 0o444);
  return {
    edgeFragmentDigest,
    manifest,
    outputRoot: root,
    renderedComposeDigest,
    sharedConfigDigest,
  };
}

export async function renderFixture(fixture, outputRoot, { verifyDigest = true } = {}) {
  const manifest = await readFixtureManifest(fixture);
  return renderActivationManifest(manifest, outputRoot, { label: fixture, verifyDigest });
}

export function composeArguments(rendered) {
  const args = ["compose", "--project-name", `esmii-prompt04-${rendered.manifest.release_id}`];
  for (const file of rendered.manifest.active_compose_files)
    args.push("-f", join(rendered.outputRoot, file));
  return args;
}

function serviceNetworks(service) {
  if (Array.isArray(service.networks)) return new Map(service.networks.map((name) => [name, {}]));
  return new Map(Object.entries(service.networks ?? {}));
}

function mountMap(service) {
  return new Map((service.volumes ?? []).map((mount) => [mount.target, mount]));
}

function assertHardened(service, name) {
  if (service.read_only !== true) fail(`${name} root filesystem is writable`);
  if (
    service.privileged === true ||
    service.network_mode === "host" ||
    service.pid === "host" ||
    service.ipc === "host"
  ) {
    fail(`${name} uses a forbidden host/privileged mode`);
  }
  if ((service.devices ?? []).length > 0) fail(`${name} mounts a device`);
  if ((service.cap_add ?? []).length > 0) fail(`${name} adds capabilities`);
}

export function validateRenderedHostCompose(configuration, manifest) {
  const services = plainObject(configuration.services, "Compose services");
  const expectedStaging = [
    "caddy",
    "staging-api",
    "staging-mailpit",
    "staging-migrate",
    "staging-postgres",
    "staging-valkey",
    "staging-web",
    "staging-worker",
  ];
  const expectedProduction = [
    "production-api",
    "production-migrate",
    "production-postgres",
    "production-stalwart",
    "production-valkey",
    "production-web",
    "production-worker",
  ];
  const expected =
    manifest.environments.production === null
      ? expectedStaging
      : [...expectedStaging, ...expectedProduction];
  const names = Object.keys(services).sort();
  if (names.length !== expected.length || expected.some((name) => !names.includes(name))) {
    fail(`rendered service set is wrong: ${names.join(",")}`);
  }
  if (names.filter((name) => name === "caddy").length !== 1)
    fail("exactly one Caddy service is required");

  for (const [name, service] of Object.entries(services)) {
    if (
      name.endsWith("-api") ||
      name.endsWith("-worker") ||
      name.endsWith("-migrate") ||
      name.endsWith("-web")
    ) {
      assertHardened(service, name);
      if (!imagePattern.test(service.image)) fail(`${name} image is not immutable`);
    }
    if (service.image && /(?:^|:)latest(?:@|$)/u.test(service.image)) fail(`${name} uses latest`);
    for (const mount of service.volumes ?? []) {
      if (
        String(mount.source).includes("docker.sock") ||
        String(mount.target).includes("docker.sock")
      ) {
        fail(`${name} mounts the Docker socket`);
      }
    }
  }

  const ports = Object.entries(services).flatMap(([name, service]) =>
    (service.ports ?? []).map((port) => ({ ...port, name })),
  );
  const expectedPorts = new Set(["caddy:80:tcp", "caddy:443:tcp", "caddy:443:udp"]);
  if (manifest.environments.production?.mail_mode === "external") {
    expectedPorts.add("production-stalwart:25:tcp");
    expectedPorts.add("production-stalwart:993:tcp");
  }
  const actualPorts = new Set(
    ports.map((port) => `${port.name}:${Number(port.target)}:${port.protocol ?? "tcp"}`),
  );
  if (
    ports.length !== expectedPorts.size ||
    actualPorts.size !== expectedPorts.size ||
    [...actualPorts].some((port) => !expectedPorts.has(port))
  ) {
    fail(`published host ports differ: ${[...actualPorts].join(",")}`);
  }
  for (const port of ports) {
    if (port.name !== "production-stalwart" && port.host_ip)
      fail("public Caddy ports must not be loopback-bound");
    if (
      port.name === "production-stalwart" &&
      Number(port.target) === 993 &&
      port.host_ip !== "127.0.0.1"
    ) {
      fail("operational IMAPS must be loopback-only");
    }
  }

  const caddyNetworks = serviceNetworks(services.caddy);
  if (
    !caddyNetworks.has("staging-edge") ||
    (manifest.environments.production !== null) !== caddyNetworks.has("production-edge")
  ) {
    fail("Caddy edge attachments differ from active environments");
  }
  if ([...caddyNetworks.keys()].some((name) => !name.endsWith("-edge")))
    fail("Caddy joins a private network");
  const caddyMounts = mountMap(services.caddy);
  if (!caddyMounts.has("/srv/staging-public-media")) fail("Caddy lacks staging public variants");
  if ([...caddyMounts.keys()].some((target) => /private|incoming|trash/u.test(target))) {
    fail("Caddy mounts private media");
  }

  for (const environment of [
    "staging",
    ...(manifest.environments.production ? ["production"] : []),
  ]) {
    const api = services[`${environment}-api`];
    const worker = services[`${environment}-worker`];
    if (api.environment?.TRUSTED_PROXY_IP !== manifest.environments[environment].caddy_ip) {
      fail(`${environment} API does not trust the exact fixed Caddy peer`);
    }
    const apiNetworks = serviceNetworks(api);
    const edgeOptions = apiNetworks.get(`${environment}-edge`);
    if (!edgeOptions || Number(edgeOptions.gw_priority) !== 1)
      fail(`${environment} API lacks explicit edge gateway`);
    const workerNetworks = serviceNetworks(worker);
    if ([...workerNetworks.keys()].some((name) => !configuration.networks?.[name]?.internal)) {
      fail(`${environment} worker has public egress`);
    }
    const workerMounts = mountMap(worker);
    if (workerMounts.get("/srv/media/public/variants")?.read_only !== true) {
      fail(`${environment} worker can write public variants`);
    }
    const apiMounts = mountMap(api);
    if (apiMounts.get("/srv/media/public/variants")?.read_only !== true) {
      fail(`${environment} API can write public variants`);
    }
  }

  if (manifest.environments.production !== null) {
    const stalwartNetworks = serviceNetworks(services["production-stalwart"]);
    if (Number(stalwartNetworks.get("production-mail-egress")?.gw_priority) !== 1) {
      fail("Stalwart lacks explicit mail-egress gateway");
    }
    for (const [name, service] of Object.entries(services)) {
      const environment = name.startsWith("staging-")
        ? "staging"
        : name.startsWith("production-")
          ? "production"
          : null;
      if (environment === null) continue;
      const forbidden = environment === "staging" ? "production" : "staging";
      const references = [
        ...serviceNetworks(service).keys(),
        ...Object.keys(service.depends_on ?? {}),
        ...(service.secrets ?? []).map((secret) => String(secret.source)),
        ...(service.volumes ?? []).map((mount) => String(mount.source)),
        ...Object.values(service.environment ?? {}).map(String),
      ];
      if (
        references.some(
          (reference) =>
            reference.startsWith(`${forbidden}-`) ||
            reference.startsWith(`${forbidden}_`) ||
            reference.includes(`/srv/myapp/${forbidden}/`) ||
            reference.includes(`/etc/myapp/secrets/${forbidden}/`),
        )
      ) {
        fail(`${name} references ${forbidden}`);
      }
    }
  }

  const serialized = JSON.stringify(configuration);
  if (unresolvedPattern.test(serialized)) fail("rendered Compose retains a placeholder");
  return { ports: ports.length, services: names.length };
}

export function runComposeValidation(rendered) {
  const docker = createLocalDockerInvocation();
  const args = [...composeArguments(rendered), "--profile", "tools", "config", "--format", "json"];
  console.log(`Local Docker command: ${formatLocalDockerCommand(docker, args)}`);
  const result = spawnLocalDocker(docker, args, {
    cwd: join(rendered.outputRoot, "infra"),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    fail("Docker Compose rejected the sealed fixture");
  }
  const configuration = JSON.parse(result.stdout);
  return validateRenderedHostCompose(configuration, rendered.manifest);
}

export function runCaddyValidation(rendered) {
  const docker = createLocalDockerInvocation();
  const caddyRoot = join(rendered.outputRoot, "infra", "caddy");
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--user",
    "65532:65532",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--tmpfs",
    "/data:rw,noexec,nosuid,nodev,size=16m",
    "--tmpfs",
    "/config:rw,noexec,nosuid,nodev,size=16m",
    "-v",
    `${caddyRoot}:/etc/caddy:ro`,
    caddyImage,
    "caddy",
    "validate",
    "--config",
    "/etc/caddy/Caddyfile",
    "--adapter",
    "caddyfile",
  ];
  console.log(`Local Docker command: ${formatLocalDockerCommand(docker, args)}`);
  const result = spawnLocalDocker(docker, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    fail("Caddy rejected the sealed fixture");
  }
  return result.stdout.trim();
}

export async function validateSourceTemplates() {
  const checks = [
    [
      "infra/compose.staging.yaml",
      new Set([
        "STAGING_CADDY_IP",
        "STAGING_SERVER_IMAGE",
        "STAGING_WEB_IMAGE",
        "STAGING_APP_DOMAIN",
        "STAGING_EDGE_SUBNET",
      ]),
    ],
    [
      "infra/compose.production.yaml",
      new Set([
        "PRODUCTION_CADDY_IP",
        "PRODUCTION_SERVER_IMAGE",
        "PRODUCTION_WEB_IMAGE",
        "PRODUCTION_APP_DOMAIN",
        "PRODUCTION_EDGE_SUBNET",
        "PRODUCTION_MAIL_ADMIN_SUBNET",
        "STALWART_MAIL_ADMIN_IP",
        "MAIL_HOSTNAME",
        "PRODUCTION_MAIL_PORTS_BLOCK",
      ]),
    ],
    ["infra/caddy/Caddyfile.host", new Set(["CERTIFICATE_CONTACT"])],
    [
      "infra/caddy/sites/staging.caddy",
      new Set(["STAGING_APP_DOMAIN", "STAGING_ADMIN_HEALTH_CIDRS"]),
    ],
    [
      "infra/caddy/sites/production-restricted.caddy",
      new Set([
        "PRODUCTION_APP_DOMAIN",
        "PRODUCTION_ADMIN_HEALTH_CIDRS",
        "PRODUCTION_PRELAUNCH_TEST_CIDRS",
      ]),
    ],
    [
      "infra/caddy/sites/production-public.caddy",
      new Set(["PRODUCTION_APP_DOMAIN", "PRODUCTION_ADMIN_HEALTH_CIDRS"]),
    ],
    ["infra/stalwart/config.toml", new Set(["MAIL_HOSTNAME", "STALWART_MAIL_ADMIN_IP"])],
  ];
  for (const [path, expected] of checks) {
    const source = await readFile(join(repositoryRoot, path), "utf8");
    if (source.includes("${")) fail(`${path} contains caller-environment interpolation`);
    const actual = new Set([...source.matchAll(/@@([A-Z0-9_]+)@@/gu)].map((match) => match[1]));
    if (actual.size !== expected.size || [...actual].some((token) => !expected.has(token))) {
      fail(`${path} token allowlist differs`);
    }
  }
  const schemaRoot = join(repositoryRoot, "infra", "release", "schemas");
  const schemaFiles = (await readdir(schemaRoot)).filter((name) => name.endsWith(".schema.json"));
  for (const name of schemaFiles) {
    const schema = JSON.parse(await readFile(join(schemaRoot, name), "utf8"));
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      fail(`${name} is not a Draft 2020-12 schema`);
    }
    if (schema.type !== "object" || schema.additionalProperties !== false) {
      fail(`${name} lacks a closed top-level object schema`);
    }
  }
  return { schemas: schemaFiles.length, templates: checks.length };
}

export function validateTransition(previous, next, target) {
  validateActivationManifest(previous);
  validateActivationManifest(next);
  if (next.deployment_epoch !== previous.deployment_epoch)
    fail("transition changed deployment epoch");
  if (next.deployment_sequence !== previous.deployment_sequence + 1)
    fail("transition sequence is not monotonic");
  if (next.previous_release_id !== previous.release_id)
    fail("transition predecessor release differs");
  const previousDigest = sha256(Buffer.from(`${canonicalJson(previous)}\n`));
  if (next.previous_activation_manifest_digest !== previousDigest)
    fail("transition predecessor digest differs");
  if (next.shared_infrastructure_payload_digest !== previous.shared_infrastructure_payload_digest) {
    fail("transition changed shared infrastructure");
  }

  if (target === "public-edge") {
    const previousProduction = previous.environments.production;
    const nextProduction = next.environments.production;
    if (!previousProduction || !nextProduction) fail("public edge requires production");
    const mutableTop = new Set([
      "release_id",
      "previous_release_id",
      "previous_activation_manifest_digest",
      "deployment_sequence",
      "change_targets",
      "shared_config_digest",
    ]);
    for (const key of Object.keys(previous)) {
      if (mutableTop.has(key) || key === "environments") continue;
      if (canonicalJson(previous[key]) !== canonicalJson(next[key]))
        fail(`public edge changed ${key}`);
    }
    if (canonicalJson(previous.environments.staging) !== canonicalJson(next.environments.staging)) {
      fail("public edge changed staging");
    }
    const mutableProduction = new Set([
      "edge_mode",
      "edge_fragment_digest",
      "prelaunch_test_cidrs",
      "prelaunch_test_cidrs_digest",
    ]);
    for (const key of Object.keys(previousProduction)) {
      if (mutableProduction.has(key)) continue;
      if (canonicalJson(previousProduction[key]) !== canonicalJson(nextProduction[key])) {
        fail(`public edge changed production.${key}`);
      }
    }
    if (previousProduction.edge_mode !== "restricted" || nextProduction.edge_mode !== "public") {
      fail("public edge transition is not restricted to public");
    }
  }
  return true;
}

export async function validateSealedRelease(releaseRoot) {
  const root = resolve(releaseRoot);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail("sealed release root is unsafe");
  const sealPath = join(root, "seal.json");
  const sealInfo = await lstat(sealPath);
  if (sealInfo.isSymbolicLink() || !sealInfo.isFile() || (sealInfo.mode & 0o222) !== 0) {
    fail("sealed release seal is unsafe or writable");
  }
  const seal = JSON.parse(await readFile(sealPath, "utf8"));
  const digestValue = await canonicalComposeDigest(seal.active_compose_files, root);
  if (digestValue !== seal.rendered_compose_digest) fail("sealed release Compose digest drifted");
  return seal;
}

export function validatedHostComposeSubcommand(command) {
  const allowed = new Map([
    ["verify", []],
    ["config", ["config", "--quiet"]],
    ["ps", ["ps"]],
  ]);
  if (!allowed.has(command)) fail(`host Compose subcommand is forbidden: ${command}`);
  return allowed.get(command);
}

export function validateDeploymentRequest(request, policy, state) {
  for (const value of [request, policy, state]) plainObject(value, "deployment control input");
  if (request.signed !== true || request.provenance_verified !== true)
    fail("deployment request is unsigned or unattested");
  if (request.repository !== policy.repository || request.branch !== "dev")
    fail("deployment repository/branch is forbidden");
  if (request.environment !== "staging") fail("automatic policy denies non-staging deployment");
  if (
    request.shared_infrastructure_payload_digest !== policy.shared_infrastructure_payload_digest
  ) {
    fail("automatic staging cannot change shared infrastructure");
  }
  const policyDigest = sha256(Buffer.from(`${canonicalJson(policy)}\n`));
  if (request.policy_digest !== policyDigest) fail("deployment policy digest differs");
  if (request.deployment_epoch !== state.deployment_epoch) fail("deployment epoch differs");
  if (request.deployment_sequence !== state.deployment_sequence + 1)
    fail("deployment request is replayed or skips a sequence");
  if (request.previous_release_id !== state.active_release_id)
    fail("deployment predecessor differs");
  if (!Array.isArray(request.active_compose_files)) fail("deployment overlay set is missing");
  const expected =
    state.production === null
      ? ["infra/compose.yaml", "infra/compose.staging.yaml"]
      : ["infra/compose.yaml", "infra/compose.staging.yaml", "infra/compose.production.yaml"];
  if (canonicalJson(request.active_compose_files) !== canonicalJson(expected))
    fail("deployment overlay set is forbidden");
  if (![request.web_image, request.server_image].every((image) => imagePattern.test(image))) {
    fail("deployment image is mutable or invalid");
  }
  if (canonicalJson(request.production) !== canonicalJson(state.production)) {
    fail("automatic staging changed production");
  }
  return true;
}

export async function validateStalwartToml(rendered) {
  if (rendered.manifest.environments.production === null) return { skipped: true };
  const path = join(rendered.outputRoot, "infra", "stalwart", "config.toml");
  const source = await readFile(path, "utf8");
  const keys = new Set();
  let section = "";
  for (const [index, rawLine] of source.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[([A-Za-z0-9_.-]+)\]$/u.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/u.exec(line);
    if (!assignment) fail(`Stalwart TOML has invalid syntax on line ${index + 1}`);
    const logical = `${section}.${assignment[1]}`;
    if (keys.has(logical)) fail(`Stalwart TOML repeats ${logical}`);
    keys.add(logical);
    const value = assignment[2];
    if (
      !/^(?:true|false|-?[0-9]+|"(?:[^"\\]|\\.)*"|\[(?:\s*"(?:[^"\\]|\\.)*"\s*,?)*\])$/u.test(value)
    ) {
      fail(`Stalwart TOML has an unsupported value on line ${index + 1}`);
    }
  }
  for (const required of [
    "server.hostname",
    "server.listener.management.bind",
    "webhook.delivery-feedback.key-file",
  ]) {
    if (!keys.has(required)) fail(`Stalwart TOML lacks ${required}`);
  }
  const program = [
    "import pathlib,sys,tomllib",
    "data=tomllib.loads(pathlib.Path(sys.argv[1]).read_text())",
    "assert data['server']['listener']['management']['bind']",
    "assert data['webhook']['delivery-feedback']['key-file'].startswith('/run/secrets/')",
  ].join(";");
  const result = spawnSync("python3", ["-c", program, path], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  if (result.status !== 0 && !result.stderr.includes("No module named 'tomllib'")) {
    fail(`Stalwart TOML syntax check failed: ${result.stderr.trim()}`);
  }
  return { parser: result.status === 0 ? "python-tomllib" : "strict-structural", skipped: false };
}
