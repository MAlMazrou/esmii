import type { DatabaseClient } from "@esmii/database";
import {
  APIError,
  betterAuth,
  type Auth,
  type BetterAuthOptions,
  type SocialProviders,
  type ValidateUserInfoAction,
} from "better-auth";
import { createAccessControl } from "better-auth/plugins/access";
import { magicLink } from "better-auth/plugins/magic-link";
import { organization } from "better-auth/plugins/organization";
import { testUtils } from "better-auth/plugins";
import { defaultStatements } from "better-auth/plugins/organization/access";

import {
  canonicalizeEmail,
  hashActionToken,
  requireWorkerMagicLinkIssuance,
  runWithWorkerMagicLinkIssuance,
  type WorkerMagicLinkIssuance,
} from "./issuance-context.js";
import type { AuthDeploymentMode } from "./mock-provider.js";
import {
  containsAsciiControlCharacter,
  normalizeApplicationOrigin,
  validateCleanSameOriginCallback,
} from "./security.js";

const AUTH_BASE_PATH = "/api/auth";
const MAGIC_LINK_EXPIRY_SECONDS = 10 * 60;
const INVITATION_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

export const AUTH_DATABASE_CONNECTION_OPTIONS = "-c search_path=app,public";

export type AuthRuntimeRole = "api" | "worker";

export interface OAuthClientConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface AuthSocialProviderConfiguration {
  readonly apple?: OAuthClientConfiguration;
  readonly google?: OAuthClientConfiguration;
  readonly microsoft?: OAuthClientConfiguration;
}

export interface AuthSessionPolicy {
  readonly expiresInSeconds: number;
  readonly freshAgeSeconds: number;
  readonly updateAgeSeconds: number;
}

export interface SocialIdentityAdmissionInput {
  readonly action: ValidateUserInfoAction;
  readonly email: string;
  readonly providerId: string;
}

export interface TransientMagicLinkDelivery {
  readonly approvedCallbackPath: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly intentId: string;
  readonly keyVersion: string;
  readonly stableMessageId: string;
  /** Transient only. It must never be persisted, queued, or logged. */
  readonly url: string;
}

export interface CreateAuthOptions {
  readonly applicationOrigin: string;
  readonly authSecret: string;
  readonly deploymentMode: AuthDeploymentMode;
  readonly pool: DatabaseClient["pool"];
  readonly runtimeRole: AuthRuntimeRole;
  readonly sessionPolicy: AuthSessionPolicy;
  readonly socialProviders?: AuthSocialProviderConfiguration;
  readonly trustedOrigins: readonly string[];
  readonly validateSocialIdentity?: (
    identity: SocialIdentityAdmissionInput,
  ) => boolean | Promise<boolean>;
  readonly deliverMagicLink?: (message: TransientMagicLinkDelivery) => Promise<void>;
}

type BetterAuthBase = Auth<BetterAuthOptions>;
type MagicLinkEndpoints = ReturnType<typeof magicLink>["endpoints"];

export interface EsmiiAuth {
  readonly $context: Promise<unknown>;
  readonly api: BetterAuthBase["api"] & MagicLinkEndpoints;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly handler: (request: Request) => Promise<Response>;
  readonly options: BetterAuthOptions;
}

const organizationAccessControl = createAccessControl(defaultStatements);

export const esmiiOrganizationRoles = Object.freeze({
  editor: organizationAccessControl.newRole({
    ac: [],
    invitation: ["create", "cancel"],
    member: [],
    organization: [],
    team: [],
  }),
  member: organizationAccessControl.newRole({
    ac: [],
    invitation: [],
    member: [],
    organization: [],
    team: [],
  }),
  owner: organizationAccessControl.newRole({
    ac: [],
    invitation: ["create", "cancel"],
    member: ["create", "update", "delete"],
    organization: ["update", "delete"],
    team: [],
  }),
});

function requireNonEmptyConfiguration(value: string, name: string): void {
  if (value.length === 0 || value !== value.trim() || containsAsciiControlCharacter(value)) {
    throw new TypeError(`${name} must be a non-empty configuration value`);
  }
}

function validateSessionPolicy(policy: AuthSessionPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer number of seconds`);
    }
  }
  if (policy.updateAgeSeconds >= policy.expiresInSeconds) {
    throw new TypeError("session update age must be shorter than session expiry");
  }
  if (policy.freshAgeSeconds > policy.expiresInSeconds) {
    throw new TypeError("session fresh age must not exceed session expiry");
  }
}

export function assertAuthPoolSearchPath(pool: Pick<DatabaseClient["pool"], "options">): void {
  if (pool.options.options !== AUTH_DATABASE_CONNECTION_OPTIONS) {
    throw new TypeError(
      `the authentication database pool must use ${AUTH_DATABASE_CONNECTION_OPTIONS}`,
    );
  }
}

function validateProviderConfiguration(
  provider: string,
  configuration: OAuthClientConfiguration,
): void {
  requireNonEmptyConfiguration(configuration.clientId, `${provider}.clientId`);
  requireNonEmptyConfiguration(configuration.clientSecret, `${provider}.clientSecret`);
}

function callbackURL(applicationOrigin: string, provider: string): string {
  return new URL(`${AUTH_BASE_PATH}/callback/${provider}`, applicationOrigin).toString();
}

function buildSocialProviders(
  applicationOrigin: string,
  deploymentMode: AuthDeploymentMode,
  configuration: AuthSocialProviderConfiguration | undefined,
): SocialProviders {
  const providers: SocialProviders = {};

  if (configuration?.google !== undefined) {
    validateProviderConfiguration("google", configuration.google);
    providers.google = {
      clientId: configuration.google.clientId,
      clientSecret: configuration.google.clientSecret,
      disableIdTokenSignIn: true,
      enabled: true,
      redirectURI: callbackURL(applicationOrigin, "google"),
      requireEmailVerification: true,
    };
  }

  if (configuration?.microsoft !== undefined) {
    validateProviderConfiguration("microsoft", configuration.microsoft);
    providers.microsoft = {
      clientId: configuration.microsoft.clientId,
      clientSecret: configuration.microsoft.clientSecret,
      disableIdTokenSignIn: true,
      enabled: true,
      redirectURI: callbackURL(applicationOrigin, "microsoft"),
      requireEmailVerification: true,
      tenantId: "common",
    };
  }

  if (configuration?.apple !== undefined) {
    if (deploymentMode === "development" || deploymentMode === "test") {
      throw new TypeError("Apple authentication is disabled in local development and tests");
    }
    validateProviderConfiguration("apple", configuration.apple);
    providers.apple = {
      clientId: configuration.apple.clientId,
      clientSecret: configuration.apple.clientSecret,
      disableIdTokenSignIn: true,
      enabled: true,
      redirectURI: callbackURL(applicationOrigin, "apple"),
      requireEmailVerification: true,
    };
  }

  return providers;
}

function requireManagedInvitationRole(role: string): void {
  if (role !== "editor" && role !== "member") {
    throw new APIError("FORBIDDEN", {
      code: "ORGANIZATION_ROLE_NOT_ALLOWED",
      message: "The requested organization role is not allowed",
    });
  }
}

function requireManagedMembershipRole(role: string): void {
  if (role !== "owner" && role !== "editor" && role !== "member") {
    throw new APIError("FORBIDDEN", {
      code: "ORGANIZATION_ROLE_NOT_ALLOWED",
      message: "The requested organization role is not allowed",
    });
  }
}

function requireVerifiedOrganizationCreator(emailVerified: boolean): boolean {
  return emailVerified;
}

function verifyGeneratedMagicLink(
  urlValue: string,
  rawToken: string,
  approvedCallbackPath: string,
  applicationOrigin: string,
): void {
  const url = new URL(urlValue);
  if (
    url.origin !== applicationOrigin ||
    url.pathname !== `${AUTH_BASE_PATH}/magic-link/verify` ||
    url.hash !== "" ||
    url.searchParams.get("token") !== rawToken ||
    url.searchParams.has("newUserCallbackURL") ||
    url.searchParams.has("errorCallbackURL")
  ) {
    throw new Error("Better Auth generated an unexpected magic-link URL");
  }

  const callbackPath = validateCleanSameOriginCallback(
    url.searchParams.get("callbackURL") ?? "/",
    applicationOrigin,
  );
  if (callbackPath !== approvedCallbackPath) {
    throw new Error("Better Auth magic-link callback does not match the issuance intent");
  }
}

export function createAuth(options: CreateAuthOptions): EsmiiAuth {
  const applicationOrigin = normalizeApplicationOrigin(options.applicationOrigin);
  if (
    (options.deploymentMode === "staging" || options.deploymentMode === "production") &&
    !applicationOrigin.startsWith("https://")
  ) {
    throw new TypeError("staging and production authentication require an HTTPS origin");
  }
  if (options.authSecret.length < 32 || /\s/u.test(options.authSecret)) {
    throw new TypeError("authSecret must contain at least 32 non-whitespace characters");
  }
  assertAuthPoolSearchPath(options.pool);
  validateSessionPolicy(options.sessionPolicy);

  const trustedOrigins = options.trustedOrigins.map(normalizeApplicationOrigin);
  if (new Set(trustedOrigins).size !== trustedOrigins.length) {
    throw new TypeError("trustedOrigins must not contain duplicates");
  }
  if (
    (options.deploymentMode === "staging" || options.deploymentMode === "production") &&
    trustedOrigins.some((origin) => !origin.startsWith("https://"))
  ) {
    throw new TypeError("staging and production trusted origins must use HTTPS");
  }
  if (options.deploymentMode === "staging" && options.validateSocialIdentity === undefined) {
    throw new TypeError("staging requires an explicit social identity admission policy");
  }
  if (options.runtimeRole === "api" && options.deliverMagicLink !== undefined) {
    throw new TypeError("the API runtime must not receive a magic-link delivery capability");
  }
  if (options.runtimeRole === "worker" && options.deliverMagicLink === undefined) {
    throw new TypeError("the worker runtime requires a magic-link delivery capability");
  }

  const socialProviders = buildSocialProviders(
    applicationOrigin,
    options.deploymentMode,
    options.socialProviders,
  );

  return betterAuth({
    account: {
      accountLinking: {
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
        disableImplicitLinking: true,
        enabled: true,
        trustedProviders: [],
        updateUserInfoOnLink: false,
      },
      encryptOAuthTokens: true,
      skipStateCookieCheck: false,
      storeAccountCookie: false,
      storeStateStrategy: "database",
    },
    advanced: {
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: options.deploymentMode === "staging" || options.deploymentMode === "production",
      },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      useSecureCookies:
        options.deploymentMode === "staging" || options.deploymentMode === "production",
    },
    appName: "Esmii",
    basePath: AUTH_BASE_PATH,
    baseURL: applicationOrigin,
    database: options.pool,
    emailAndPassword: { enabled: false },
    plugins: [
      magicLink({
        disableSignUp: false,
        expiresIn: MAGIC_LINK_EXPIRY_SECONDS,
        async generateToken(email) {
          if (options.runtimeRole !== "worker") {
            throw new Error("only the worker runtime may generate magic-link tokens");
          }
          const issuance = requireWorkerMagicLinkIssuance();
          if (canonicalizeEmail(email) !== issuance.normalizedEmail) {
            throw new Error("magic-link email does not match the issuance intent");
          }
          return issuance.rawToken;
        },
        sendMagicLink: async ({ email, token, url }) => {
          const issuance = requireWorkerMagicLinkIssuance();
          if (
            options.runtimeRole !== "worker" ||
            options.deliverMagicLink === undefined ||
            canonicalizeEmail(email) !== issuance.normalizedEmail ||
            token !== issuance.rawToken ||
            issuance.expiresAt.getTime() <= Date.now()
          ) {
            throw new Error("magic-link delivery is not authorized for this invocation");
          }

          verifyGeneratedMagicLink(
            url,
            issuance.rawToken,
            issuance.approvedCallbackPath,
            applicationOrigin,
          );
          await options.deliverMagicLink({
            approvedCallbackPath: issuance.approvedCallbackPath,
            email: issuance.normalizedEmail,
            expiresAt: new Date(issuance.expiresAt),
            intentId: issuance.intentId,
            keyVersion: issuance.keyVersion,
            stableMessageId: issuance.stableMessageId,
            url,
          });
        },
        storeToken: {
          type: "custom-hasher",
          async hash(token) {
            return hashActionToken(token);
          },
        },
      }),
      organization({
        ac: organizationAccessControl,
        allowUserToCreateOrganization: (user) =>
          requireVerifiedOrganizationCreator(user.emailVerified),
        cancelPendingInvitationsOnReInvite: true,
        creatorRole: "owner",
        disableOrganizationDeletion: true,
        invitationExpiresIn: INVITATION_EXPIRY_SECONDS,
        organizationHooks: {
          async beforeAddMember({ member }) {
            requireManagedMembershipRole(member.role);
          },
          async beforeCreateInvitation({ invitation }) {
            requireManagedInvitationRole(invitation.role);
          },
          async beforeUpdateMemberRole({ newRole }) {
            requireManagedInvitationRole(newRole);
          },
        },
        requireEmailVerificationOnInvitation: true,
        roles: esmiiOrganizationRoles,
      }),
      ...(options.runtimeRole === "api" &&
      (options.deploymentMode === "development" || options.deploymentMode === "test")
        ? [testUtils() as unknown as NonNullable<BetterAuthOptions["plugins"]>[number]]
        : []),
    ],
    secret: options.authSecret,
    session: {
      cookieCache: { enabled: false },
      expiresIn: options.sessionPolicy.expiresInSeconds,
      freshAge: options.sessionPolicy.freshAgeSeconds,
      updateAge: options.sessionPolicy.updateAgeSeconds,
    },
    socialProviders,
    trustedOrigins,
    user: {
      validateUserInfo: async ({ source, user }) => {
        if (source.method !== "oauth") {
          return;
        }

        if (
          user.emailVerified !== true ||
          typeof user.email !== "string" ||
          source.oauth?.providerId === undefined
        ) {
          return {
            error: "IDENTITY_NOT_ALLOWED",
            errorDescription: "This provider identity cannot be used",
          };
        }

        const email = canonicalizeEmail(user.email);
        if (
          options.validateSocialIdentity !== undefined &&
          !(await options.validateSocialIdentity({
            action: source.action,
            email,
            providerId: source.oauth.providerId,
          }))
        ) {
          return {
            error: "IDENTITY_NOT_ALLOWED",
            errorDescription: "This provider identity cannot be used",
          };
        }
      },
    },
  });
}

export async function issueWorkerMagicLink(
  auth: EsmiiAuth,
  issuance: WorkerMagicLinkIssuance,
  applicationOriginValue: string,
): Promise<{ status: boolean }> {
  const applicationOrigin = normalizeApplicationOrigin(applicationOriginValue);
  return runWithWorkerMagicLinkIssuance(issuance, applicationOrigin, async () => {
    return auth.api.signInMagicLink({
      body: {
        callbackURL: issuance.approvedCallbackPath,
        email: issuance.normalizedEmail,
      },
      headers: new Headers({ origin: applicationOrigin }),
    });
  });
}
