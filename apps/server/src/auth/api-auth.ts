import type { AppEnvironment, AuthenticationConfig } from "@esmii/config";
import type { DatabaseClient } from "@esmii/database";

import { createAuth, type EsmiiAuth } from "./create-auth.js";
import { resolveAuthSocialProviders } from "./providers.js";

export async function createApiAuth(input: {
  authentication: AuthenticationConfig;
  database: DatabaseClient;
  environment: AppEnvironment;
}): Promise<EsmiiAuth> {
  const socialProviders = await resolveAuthSocialProviders(
    input.authentication.providers,
    input.environment,
  );
  return createAuth({
    applicationOrigin: input.authentication.publicOrigin,
    authSecret: input.authentication.betterAuthSecret,
    deploymentMode: input.environment,
    pool: input.database.pool,
    runtimeRole: "api",
    sessionPolicy: {
      expiresInSeconds: input.authentication.sessionLifetimeSeconds,
      freshAgeSeconds: input.authentication.recentAuthenticationSeconds,
      updateAgeSeconds: Math.min(24 * 60 * 60, input.authentication.sessionLifetimeSeconds - 1),
    },
    socialProviders,
    trustedOrigins: [input.authentication.publicOrigin],
    ...(input.environment === "staging"
      ? {
          validateSocialIdentity: ({ email }: { email: string }) =>
            input.authentication.stagingAccessMode === "open" ||
            input.authentication.stagingTesterEmails.has(email),
        }
      : {}),
  });
}
