import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { validateDevelopmentCompose } from "../../scripts/development-compose-policy.mjs";

const repositoryRoot = resolve(".");

function applicationService(volumes = []) {
  return { read_only: true, user: "10001:10001", volumes };
}

function volume(source, target, readOnly = false) {
  return { read_only: readOnly, source, target, type: "volume" };
}

function validConfiguration() {
  return {
    networks: {
      "development-data": { internal: true },
      "development-edge": {},
      "development-mail": { internal: true },
      "development-operator": {},
      "development-storage": { internal: true },
    },
    secrets: {
      example: { file: resolve(repositoryRoot, ".local/development/secrets/example") },
    },
    services: {
      caddy: {
        ports: [{ host_ip: "127.0.0.1", published: "8080", target: 80 }],
        volumes: [
          {
            source: resolve(repositoryRoot, "infra/caddy/Caddyfile"),
            target: "/etc/caddy/Caddyfile",
            type: "bind",
          },
        ],
      },
      "development-api": applicationService([
        volume("development-private-incoming", "/srv/media/private/incoming"),
        volume("development-private-originals", "/srv/media/private/originals", true),
        volume("development-private-variants", "/srv/media/private/variants", true),
        volume("development-public-media", "/srv/media/public/variants", true),
      ]),
      "development-mailpit": {
        ports: [{ host_ip: "127.0.0.1", published: "8025", target: 8025 }],
      },
      "development-migrate": applicationService(),
      "development-web": applicationService(),
      "development-worker": applicationService([
        volume("development-private-incoming", "/srv/media/private/incoming"),
        volume("development-private-originals", "/srv/media/private/originals"),
        volume("development-private-trash", "/srv/media/private/trash"),
        volume("development-private-variants", "/srv/media/private/variants"),
        volume("development-public-media", "/srv/media/public/variants", true),
      ]),
    },
  };
}

describe("development Compose policy", () => {
  it("accepts the local-only least-privilege model", () => {
    const summary = validateDevelopmentCompose(
      JSON.stringify(validConfiguration()),
      repositoryRoot,
    );
    expect(summary).toEqual({ applicationServices: 4, publishedPorts: 2 });
  });

  it("rejects privileged or non-loopback published ports", () => {
    const privileged = validConfiguration();
    privileged.services.caddy.ports[0].published = "80";
    expect(() => validateDevelopmentCompose(JSON.stringify(privileged), repositoryRoot)).toThrow(
      /unprivileged/u,
    );

    const publicBind = validConfiguration();
    publicBind.services.caddy.ports[0].host_ip = "0.0.0.0";
    expect(() => validateDevelopmentCompose(JSON.stringify(publicBind), repositoryRoot)).toThrow(
      /non-loopback/u,
    );
  });

  it("rejects host binds outside the repository", () => {
    const configuration = validConfiguration();
    configuration.services.caddy.volumes[0].source = "/srv/myapp/production/media";
    expect(() => validateDevelopmentCompose(JSON.stringify(configuration), repositoryRoot)).toThrow(
      /outside the repository/u,
    );
  });

  it("rejects a broad private-media mount", () => {
    const configuration = validConfiguration();
    configuration.services["development-api"].volumes.push(
      volume("development-private", "/srv/media/private"),
    );
    expect(() => validateDevelopmentCompose(JSON.stringify(configuration), repositoryRoot)).toThrow(
      /complete private-media root/u,
    );
  });
});
