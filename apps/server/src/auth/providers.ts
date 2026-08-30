import type { AppEnvironment, AuthProviderConfig } from "@esmii/config";
import { importPKCS8, SignJWT } from "jose";

import type { AuthSocialProviderConfiguration } from "./create-auth.js";

const appleAudience = "https://appleid.apple.com";
const appleClientSecretLifetimeSeconds = 180 * 24 * 60 * 60;

export async function resolveAuthSocialProviders(
  providers: AuthProviderConfig,
  environment: AppEnvironment,
  now: Date = new Date(),
): Promise<AuthSocialProviderConfiguration> {
  const resolved: AuthSocialProviderConfiguration = {
    ...(providers.google === undefined
      ? {}
      : {
          google: {
            clientId: providers.google.clientId,
            clientSecret: providers.google.clientSecret as string,
          },
        }),
    ...(providers.microsoft === undefined
      ? {}
      : {
          microsoft: {
            clientId: providers.microsoft.clientId,
            clientSecret: providers.microsoft.clientSecret as string,
          },
        }),
  };
  if (providers.apple === undefined) return resolved;
  if (environment === "development" || environment === "test") {
    throw new TypeError("Apple authentication is disabled in local development and tests");
  }
  const { clientId, keyId, privateKey, teamId } = providers.apple;
  if (keyId === undefined || privateKey === undefined || teamId === undefined) {
    throw new TypeError("Apple identity configuration is incomplete");
  }
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const signingKey = await importPKCS8(privateKey, "ES256");
  const clientSecret = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setSubject(clientId)
    .setAudience(appleAudience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + appleClientSecretLifetimeSeconds)
    .sign(signingKey);
  return { ...resolved, apple: { clientId, clientSecret } };
}
