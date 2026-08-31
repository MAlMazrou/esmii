import { createHmac } from "node:crypto";

import { loadHttpServerConfig } from "@esmii/config/server";
import { createDatabaseClient, getViewerContext } from "@esmii/database";

import { buildApp } from "../app.js";
import { createApiAuth } from "../auth/api-auth.js";
import { BetterAuthAuthenticationSeam } from "../auth/fastify.js";
import { BetterAuthProviderLinkingSeam } from "../auth/provider-linking.js";
import { createPublicConfiguration } from "../auth/public-configuration.js";
import { BetterAuthSessionTerminationSeam } from "../auth/session-termination.js";
import {
  createOrganizationRealtimeServer,
  type OrganizationRealtimePublisher,
  type OrganizationRealtimeServerHandle,
} from "../realtime/index.js";
import { createRuntimeDependencyProbes } from "../runtime/dependency-probes.js";
import { HashedAbuseRateLimiter, ValkeyAbuseRateLimitStore } from "../security/rate-limiter.js";
import {
  createPostgresAccountHttpService,
  createRuntimeTombstoneOrchestrator,
  PostgresActionExchangeSeam,
} from "../services/index.js";

function rateLimitKey(authSecret: string): Uint8Array {
  return createHmac("sha256", authSecret).update("esmii-api-rate-limit-key-v1", "utf8").digest();
}

async function main(): Promise<void> {
  const configuration = await loadHttpServerConfig();
  const database = createDatabaseClient({
    applicationName: "esmii-api",
    connectionString: configuration.databaseUrl,
    onUnexpectedError() {
      process.stderr.write("An unexpected database pool error occurred.\n");
    },
    role: "api",
  });
  const rateLimitStore = new ValkeyAbuseRateLimitStore(configuration.valkeyUrl);
  let app: ReturnType<typeof buildApp> | null = null;
  let realtime: OrganizationRealtimeServerHandle | null = null;

  try {
    const auth = await createApiAuth({
      authentication: configuration.authentication,
      database,
      environment: configuration.appEnvironment,
    });
    const authentication = new BetterAuthAuthenticationSeam(auth);
    const tombstones = await createRuntimeTombstoneOrchestrator({
      allowProductionCapture: configuration.initialPublicShellMode,
      database,
      environment: configuration.appEnvironment,
      mode: configuration.securityTombstoneMode,
    });
    const abuseRateLimiter = new HashedAbuseRateLimiter({
      environment: configuration.appEnvironment,
      key: rateLimitKey(configuration.authentication.betterAuthSecret),
      store: rateLimitStore,
    });

    let realtimePublisher: OrganizationRealtimePublisher | null = null;
    const publisher: OrganizationRealtimePublisher = {
      async invalidateOrganization(input) {
        if (realtimePublisher === null) throw new Error("realtime publisher is not ready");
        await realtimePublisher.invalidateOrganization(input);
      },
      async revokeOrganizationAccess(input) {
        if (realtimePublisher === null) throw new Error("realtime publisher is not ready");
        return realtimePublisher.revokeOrganizationAccess(input);
      },
    };

    const service = createPostgresAccountHttpService({
      actionExchange: new PostgresActionExchangeSeam({
        environment: configuration.appEnvironment,
        pool: database.pool,
      }),
      appEnvironment: configuration.appEnvironment,
      ...(configuration.appEnvironment === "staging"
        ? {
            isMagicLinkRecipientAllowed: (email: string) =>
              configuration.authentication.stagingAccessMode === "open" ||
              configuration.authentication.stagingTesterEmails.has(email),
          }
        : {}),
      pool: database.pool,
      providerLinking: new BetterAuthProviderLinkingSeam({
        applicationOrigin: configuration.authentication.publicOrigin,
        auth,
      }),
      publicConfiguration: createPublicConfiguration(configuration.authentication.providers),
      realtime: publisher,
      recentAuthenticationSeconds: configuration.authentication.recentAuthenticationSeconds,
      sessionTermination: new BetterAuthSessionTerminationSeam({
        applicationOrigin: configuration.authentication.publicOrigin,
        auth,
      }),
      tombstones,
    });

    app = buildApp({
      actionLinks: {
        auth,
        database,
        environment: configuration.appEnvironment,
        publicOrigin: configuration.authentication.publicOrigin,
      },
      betterAuth: {
        applicationOrigin: configuration.authentication.publicOrigin,
        auth,
      },
      dependencyProbes: createRuntimeDependencyProbes(database, configuration.valkeyUrl),
      account: {
        abuseRateLimiter,
        authentication,
        service,
      },
      logger: true,
      mockAuth: {
        auth,
        database,
        environment: configuration.appEnvironment,
        mockProviders: configuration.authentication.providers.mockProviders,
      },
      operationsHealthToken: configuration.operationsHealthToken,
      ...(configuration.trustedProxyIp === undefined
        ? {}
        : { trustedProxyIp: configuration.trustedProxyIp }),
    });
    realtime = createOrganizationRealtimeServer(app.server, {
      applicationOrigin: configuration.authentication.publicOrigin,
      authentication,
      async resolveAccess(principal) {
        const viewer = await getViewerContext(database.pool, principal);
        return {
          activeOrganizationId: viewer?.activeOrganizationId ?? null,
          membershipActive: viewer !== null && viewer.activeOrganizationId !== null,
        };
      },
    });
    realtimePublisher = realtime.publisher;

    let shuttingDown = false;
    const shutDown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      await realtime?.close().catch(() => undefined);
      await app?.close().catch(() => undefined);
      await rateLimitStore.close().catch(() => undefined);
      await database.close().catch(() => undefined);
    };
    process.once("SIGINT", () => void shutDown());
    process.once("SIGTERM", () => void shutDown());

    await app.listen({ host: configuration.host, port: configuration.port });
  } catch {
    await realtime?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await rateLimitStore.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    process.stderr.write("Server startup failed; inspect configuration and dependency health.\n");
    process.exitCode = 1;
  }
}

void main().catch(() => {
  process.stderr.write("Server startup failed; inspect configuration and dependency health.\n");
  process.exitCode = 1;
});
