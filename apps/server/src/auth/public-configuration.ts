import type { AuthProviderConfig } from "@esmii/config";
import type { AuthProviderId, PublicConfiguration } from "@esmii/contracts";

const providerOrder = ["google"] as const;

export function createPublicConfiguration(providers: AuthProviderConfig): PublicConfiguration {
  const mockProviders = new Set<AuthProviderId>(providers.mockProviders);
  return {
    applicationName: "Esmii",
    applicationSlug: "esmii",
    providers: providerOrder.map((id) => {
      const oauthConfigured = providers[id] !== undefined;
      const mockConfigured = mockProviders.has(id);
      return {
        enabled: oauthConfigured || mockConfigured,
        id,
        mode: oauthConfigured ? "oauth" : mockConfigured ? "mock" : "oauth",
      };
    }),
  };
}
