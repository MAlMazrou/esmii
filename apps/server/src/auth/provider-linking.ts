import type { AuthProviderId } from "@esmii/contracts";

import type { ProviderLinkingSeam } from "../services/account-service.js";
import type { EsmiiAuth } from "./create-auth.js";
import { normalizeApplicationOrigin } from "./security.js";

const providerAuthorization = Object.freeze({
  apple: { host: "appleid.apple.com", path: "/auth/authorize" },
  google: { host: "accounts.google.com", path: "/o/oauth2/v2/auth" },
  microsoft: { host: "login.microsoftonline.com", path: "/common/oauth2/v2.0/authorize" },
} satisfies Record<AuthProviderId, { host: string; path: string }>);

export function validateProviderAuthorizationUrl(provider: AuthProviderId, rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("identity provider returned an invalid authorization URL");
  }
  const expected = providerAuthorization[provider];
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== expected.host ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== expected.path ||
    parsed.hash !== "" ||
    !parsed.searchParams.has("state")
  ) {
    throw new Error("identity provider returned an unsafe authorization URL");
  }
  return parsed.toString();
}

export class BetterAuthProviderLinkingSeam implements ProviderLinkingSeam {
  readonly #applicationOrigin: string;
  readonly #auth: Pick<EsmiiAuth, "api">;

  public constructor(input: { applicationOrigin: string; auth: Pick<EsmiiAuth, "api"> }) {
    this.#applicationOrigin = normalizeApplicationOrigin(input.applicationOrigin);
    this.#auth = input.auth;
  }

  public async begin(input: {
    cookieHeader: string;
    idempotencyKey: string;
    provider: AuthProviderId;
    requestId: string;
    sessionId: string;
    userId: string;
  }): Promise<{ redirectUrl: string }> {
    const result = await this.#auth.api.linkSocialAccount({
      body: {
        callbackURL: "/app/account",
        disableRedirect: true,
        errorCallbackURL: "/sign-in/result",
        provider: input.provider,
        requestSignUp: false,
      },
      headers: new Headers({
        cookie: input.cookieHeader,
        origin: this.#applicationOrigin,
      }),
    });
    return {
      redirectUrl: validateProviderAuthorizationUrl(input.provider, result.url),
    };
  }
}
