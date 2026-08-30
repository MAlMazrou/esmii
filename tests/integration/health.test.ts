import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../apps/server/src/app.js";
import type { DependencyProbe } from "../../apps/server/src/health/dependencies.js";

const operationsToken = ["INERT", "OPERATIONS", "TOKEN", "SENTINEL", "0001"].join("_");
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

describe("account HTTP integration", () => {
  it("keeps liveness public while protecting dependency details", async () => {
    const app = createApp();
    const liveness = await app.inject({ method: "GET", url: "/api/health/live" });
    const dependencies = await app.inject({
      method: "GET",
      url: "/api/health/dependencies",
    });

    expect(liveness.statusCode).toBe(200);
    expect(liveness.json()).toEqual({ status: "ok" });
    expect(dependencies.statusCode).toBe(401);
    expect(dependencies.body).not.toContain(operationsToken);
  });

  it("reports required dependency failure without exposing its error", async () => {
    const app = createApp([
      {
        name: "postgresql",
        requiredForReadiness: true,
        async check() {
          throw new Error("INERT_DATABASE_ERROR_SENTINEL_0001");
        },
      },
    ]);

    const response = await app.inject({ method: "GET", url: "/api/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    expect(response.body).not.toContain("INERT_DATABASE_ERROR_SENTINEL_0001");
  });
});
