export type PublicAuthProviderId = "google" | "microsoft" | "apple";
export type PublicAuthProviderMode = "oauth" | "mock";

export interface PublicAuthProvider {
  enabled: boolean;
  id: PublicAuthProviderId;
  mode: PublicAuthProviderMode;
}

export interface PublicRuntimeConfig {
  applicationName: "Esmii";
  applicationSlug: "esmii";
  providers: readonly PublicAuthProvider[];
}

/** The complete browser-visible configuration allowlist. */
export function getPublicRuntimeConfig(
  providers: readonly PublicAuthProvider[] = [],
): PublicRuntimeConfig {
  return { applicationName: "Esmii", applicationSlug: "esmii", providers: [...providers] };
}
