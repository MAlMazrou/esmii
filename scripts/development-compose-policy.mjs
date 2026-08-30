import { isAbsolute, relative, resolve } from "node:path";

const applicationServices = [
  "development-api",
  "development-migrate",
  "development-web",
  "development-worker",
];

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function fail(message) {
  throw new Error(`Development Compose policy failed: ${message}`);
}

export function validateDevelopmentCompose(rendered, repositoryRoot) {
  let configuration;
  try {
    configuration = JSON.parse(rendered);
  } catch {
    fail("Docker returned invalid rendered JSON");
  }

  const services = configuration.services;
  if (services === null || typeof services !== "object") fail("services are missing");

  for (const name of applicationServices) {
    const service = services[name];
    if (service?.user !== "10001:10001") fail(`${name} must run as 10001:10001`);
    if (service.read_only !== true) fail(`${name} must use a read-only root filesystem`);
  }

  const expectedMediaMounts = {
    "development-api": {
      "/srv/media/private/incoming": ["development-private-incoming", false],
      "/srv/media/private/originals": ["development-private-originals", true],
      "/srv/media/private/variants": ["development-private-variants", true],
      "/srv/media/public/variants": ["development-public-media", true],
    },
    "development-worker": {
      "/srv/media/private/incoming": ["development-private-incoming", false],
      "/srv/media/private/originals": ["development-private-originals", false],
      "/srv/media/private/trash": ["development-private-trash", false],
      "/srv/media/private/variants": ["development-private-variants", false],
      "/srv/media/public/variants": ["development-public-media", true],
    },
  };

  for (const [serviceName, expected] of Object.entries(expectedMediaMounts)) {
    const actual = new Map(
      (services[serviceName].volumes ?? []).map((mount) => [
        mount.target,
        [mount.source, mount.read_only === true],
      ]),
    );
    for (const [target, [source, readOnly]] of Object.entries(expected)) {
      const mount = actual.get(target);
      if (mount?.[0] !== source || mount?.[1] !== readOnly) {
        fail(`${serviceName} has an invalid media mount at ${target}`);
      }
    }
    if (actual.has("/srv/media/private")) {
      fail(`${serviceName} must not mount the complete private-media root`);
    }
  }

  const publishedPorts = [];
  for (const [name, service] of Object.entries(services)) {
    for (const port of service.ports ?? []) {
      const published = Number(port.published);
      publishedPorts.push({
        host: port.host_ip,
        published,
        service: name,
        target: Number(port.target),
      });
      if (port.host_ip !== "127.0.0.1") fail(`${name} publishes a non-loopback port`);
      if (!Number.isInteger(published) || published < 1024 || published > 65_535) {
        fail(`${name} must publish only an unprivileged TCP port`);
      }
    }
  }

  const expectedPorts = new Set(["caddy:80", "development-mailpit:8025"]);
  const actualPorts = new Set(publishedPorts.map((port) => `${port.service}:${port.target}`));
  if (
    publishedPorts.length !== expectedPorts.size ||
    actualPorts.size !== expectedPorts.size ||
    [...actualPorts].some((port) => !expectedPorts.has(port))
  ) {
    fail("only Caddy HTTP and the Mailpit UI may publish development ports");
  }

  const absoluteRoot = resolve(repositoryRoot);
  for (const [name, service] of Object.entries(services)) {
    for (const mount of service.volumes ?? []) {
      if (mount.type === "bind" && !isWithin(absoluteRoot, resolve(mount.source))) {
        fail(`${name} contains a bind mount outside the repository`);
      }
    }
  }

  const localSecretsRoot = resolve(absoluteRoot, ".local", "development", "secrets");
  for (const [name, secret] of Object.entries(configuration.secrets ?? {})) {
    if (typeof secret.file !== "string" || !isWithin(localSecretsRoot, resolve(secret.file))) {
      fail(`${name} does not resolve to ignored local development secrets`);
    }
  }

  for (const name of Object.keys(services)) {
    if (name.startsWith("staging-") || name.startsWith("production-")) {
      fail("remote-environment services are present");
    }
  }

  for (const forbidden of [
    "/etc/esmii",
    "/srv/myapp",
    "/srv/esmii/staging",
    "/srv/esmii/production",
    "ghcr.io/malmazrou",
    "staging.esmii.app",
    "esmii.app",
  ]) {
    if (rendered.includes(forbidden)) fail("a remote environment marker is present");
  }

  for (const name of ["development-data", "development-mail", "development-storage"]) {
    if (configuration.networks?.[name]?.internal !== true) {
      fail(`${name} must remain internal`);
    }
  }

  return {
    applicationServices: applicationServices.length,
    publishedPorts: publishedPorts.length,
  };
}
