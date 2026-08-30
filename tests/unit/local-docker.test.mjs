import { describe, expect, it, vi } from "vitest";

import { createLocalDockerInvocation, isLocalDockerEndpoint } from "../../scripts/local-docker.mjs";

describe("local Docker guard", () => {
  it("recognizes only local transport families", () => {
    expect(isLocalDockerEndpoint("unix:///var/run/docker.sock")).toBe(true);
    expect(isLocalDockerEndpoint("npipe:////./pipe/docker_engine")).toBe(true);
    expect(isLocalDockerEndpoint("fd://")).toBe(true);
    expect(isLocalDockerEndpoint("ssh://operator@example.invalid")).toBe(false);
    expect(isLocalDockerEndpoint("tcp://192.0.2.10:2376")).toBe(false);
  });

  it("rejects an explicitly remote Docker host before context inspection", () => {
    const currentContextReader = vi.fn();
    expect(() =>
      createLocalDockerInvocation({
        environment: { DOCKER_HOST: "ssh://operator@example.invalid" },
        currentContextReader,
      }),
    ).toThrow(/non-local Docker endpoint/u);
    expect(currentContextReader).not.toHaveBeenCalled();
  });

  it("rejects a named context backed by a remote endpoint", () => {
    expect(() =>
      createLocalDockerInvocation({
        environment: { DOCKER_CONTEXT: "remote-vps" },
        contextEndpointReader: () => "tcp://192.0.2.10:2376",
      }),
    ).toThrow(/endpoint is not local/u);
  });

  it("pins a verified context and removes Compose target overrides", () => {
    const invocation = createLocalDockerInvocation({
      environment: {
        COMPOSE_FILE: "remote.yaml",
        COMPOSE_PROFILES: "remote",
        COMPOSE_PROJECT_NAME: "wrong-project",
        DOCKER_CONTEXT: "desktop-linux",
        PATH: "/usr/bin",
      },
      contextEndpointReader: () => "unix:///tmp/docker.sock",
    });

    expect(invocation.arguments).toEqual(["--context", "desktop-linux"]);
    expect(invocation.environment).toEqual({ PATH: "/usr/bin" });
  });

  it("rejects external builder selection", () => {
    expect(() =>
      createLocalDockerInvocation({
        environment: { BUILDKIT_HOST: "tcp://192.0.2.20:1234" },
      }),
    ).toThrow(/BUILDKIT_HOST/u);
  });
});
