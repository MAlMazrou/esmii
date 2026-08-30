import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { DependencyProbe } from "../src/health/dependencies.js";

const operationsToken = "o".repeat(32);
const openApps: ReturnType<typeof buildApp>[] = [];

function createApp(dependencyProbes: readonly DependencyProbe[] = []) {
  const app = buildApp({
    dependencyProbes,
    logger: false,
    operationsHealthToken: operationsToken,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("health routes", () => {
  it("keeps liveness public and minimal", async () => {
    const response = await createApp().inject({
      method: "GET",
      url: "/api/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("keeps readiness minimal when a required dependency is unavailable", async () => {
    const response = await createApp([
      {
        name: "postgresql",
        requiredForReadiness: true,
        async check() {
          throw new Error("sensitive database detail");
        },
      },
    ]).inject({ method: "GET", url: "/api/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    expect(response.body).not.toContain("postgresql");
    expect(response.body).not.toContain("sensitive database detail");
  });

  it("does not make readiness wait on an optional dependency", async () => {
    let optionalProbeRan = false;
    const response = await createApp([
      {
        name: "postgresql",
        requiredForReadiness: true,
        async check() {
          return { status: "ok" };
        },
      },
      {
        name: "mail",
        requiredForReadiness: false,
        async check() {
          optionalProbeRan = true;
          throw new Error("optional dependency unavailable");
        },
      },
    ]).inject({ method: "GET", url: "/api/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    expect(optionalProbeRan).toBe(false);
  });

  it("requires the separate operations token for dependency detail", async () => {
    const app = createApp();
    const missing = await app.inject({
      method: "GET",
      url: "/api/health/dependencies",
    });
    const incorrect = await app.inject({
      headers: { authorization: `Bearer ${"x".repeat(32)}` },
      method: "GET",
      url: "/api/health/dependencies",
    });

    expect(missing.statusCode).toBe(401);
    expect(incorrect.statusCode).toBe(401);
  });

  it("returns safe detailed status to an authorized operator", async () => {
    const response = await createApp([
      {
        name: "postgresql",
        requiredForReadiness: true,
        async check() {
          return { status: "ok" };
        },
      },
      {
        name: "mail",
        requiredForReadiness: false,
        async check() {
          throw new Error("smtp://secret@example.invalid");
        },
      },
    ]).inject({
      headers: { authorization: `Bearer ${operationsToken}` },
      method: "GET",
      url: "/api/health/dependencies",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      dependencies: {
        mail: { requiredForReadiness: false, status: "unavailable" },
        postgresql: { requiredForReadiness: true, status: "ok" },
      },
      status: "degraded",
    });
    expect(response.body).not.toContain("smtp://secret");
    expect(response.body).not.toContain(operationsToken);
  });
});
