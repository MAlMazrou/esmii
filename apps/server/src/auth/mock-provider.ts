export type AuthDeploymentMode = "development" | "production" | "staging" | "test";

export type DevelopmentMockProviderScenario =
  | "missing-email"
  | "provider-error"
  | "unverified-email"
  | "verified-existing-user"
  | "verified-new-user";

export interface DevelopmentMockIdentity {
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly name: string;
  readonly providerAccountId: string;
}

export interface DevelopmentMockProvider {
  readonly id: "esmii-development-mock";
  resolveScenario(scenario: DevelopmentMockProviderScenario): DevelopmentMockIdentity;
}

const fixedScenarios: Readonly<
  Record<Exclude<DevelopmentMockProviderScenario, "provider-error">, DevelopmentMockIdentity>
> = Object.freeze({
  "missing-email": Object.freeze({
    email: null,
    emailVerified: false,
    name: "Missing Email",
    providerAccountId: "mock-missing-email",
  }),
  "unverified-email": Object.freeze({
    email: "unverified.user@example.invalid",
    emailVerified: false,
    name: "Unverified User",
    providerAccountId: "mock-unverified-email",
  }),
  "verified-existing-user": Object.freeze({
    email: "existing.user@example.invalid",
    emailVerified: true,
    name: "Existing User",
    providerAccountId: "mock-existing-user",
  }),
  "verified-new-user": Object.freeze({
    email: "new.user@example.invalid",
    emailVerified: true,
    name: "New User",
    providerAccountId: "mock-new-user",
  }),
});

export function createDevelopmentMockProvider(
  deploymentMode: AuthDeploymentMode,
): DevelopmentMockProvider {
  if (deploymentMode !== "development" && deploymentMode !== "test") {
    throw new Error("development mock provider is unavailable outside development and test");
  }

  return Object.freeze({
    id: "esmii-development-mock" as const,
    resolveScenario(scenario: DevelopmentMockProviderScenario): DevelopmentMockIdentity {
      if (scenario === "provider-error") {
        throw new Error("synthetic provider failure");
      }
      const identity = fixedScenarios[scenario];
      if (identity === undefined) {
        throw new Error("unknown development mock provider scenario");
      }
      return identity;
    },
  });
}
