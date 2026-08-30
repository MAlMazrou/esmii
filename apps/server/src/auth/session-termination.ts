import type { SessionTerminationSeam } from "../services/account-service.js";
import type { EsmiiAuth } from "./create-auth.js";
import { normalizeApplicationOrigin } from "./security.js";

export class BetterAuthSessionTerminationSeam implements SessionTerminationSeam {
  readonly #applicationOrigin: string;
  readonly #auth: Pick<EsmiiAuth, "handler">;

  public constructor(input: { applicationOrigin: string; auth: Pick<EsmiiAuth, "handler"> }) {
    this.#applicationOrigin = normalizeApplicationOrigin(input.applicationOrigin);
    this.#auth = input.auth;
  }

  public async expire(input: {
    cookieHeader: string;
    requestId: string;
  }): Promise<{ setCookieHeaders: readonly string[] }> {
    const response = await this.#auth.handler(
      new Request(new URL("/api/auth/sign-out", this.#applicationOrigin), {
        body: "{}",
        headers: {
          "content-type": "application/json",
          cookie: input.cookieHeader,
          origin: this.#applicationOrigin,
        },
        method: "POST",
        redirect: "manual",
      }),
    );
    if (!response.ok) throw new Error("Better Auth session termination failed");
    const cookies = response.headers.getSetCookie();
    if (cookies.length === 0 || cookies.some((cookie) => !/;\s*Max-Age=0(?:;|$)/iu.test(cookie))) {
      throw new Error("Better Auth did not return session cookie expiry headers");
    }
    return { setCookieHeaders: cookies };
  }
}
