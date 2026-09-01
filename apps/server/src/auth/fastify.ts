import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuthenticationSeam, AuthenticatedPrincipal } from "../account/seams.js";
import type { EsmiiAuth } from "./create-auth.js";
import { classifyPublicAuthRoute } from "./routes.js";
import { normalizeApplicationOrigin, validateCleanSameOriginCallback } from "./security.js";

const oauthCallbackPattern = /^\/api\/auth\/callback\/(google|microsoft|apple)$/u;
const cleanOAuthTargets = new Set(["/app", "/app/account"]);
const authResultCookieLifetimeSeconds = 120;

export interface BetterAuthFastifyDependencies {
  auth: Pick<EsmiiAuth, "api" | "handler">;
  applicationOrigin: string;
}

function appendIncomingHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, String(value));
    }
  }
  return headers;
}

function requestBody(request: FastifyRequest, headers: Headers): string | ArrayBuffer | undefined {
  if (request.method === "GET" || request.method === "HEAD" || request.body === undefined) {
    return undefined;
  }
  if (typeof request.body === "string") {
    return request.body;
  }
  if (request.body instanceof Uint8Array) {
    const copy = new Uint8Array(request.body.byteLength);
    copy.set(request.body);
    return copy.buffer;
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return JSON.stringify(request.body);
}

export function toBetterAuthRequest(request: FastifyRequest, applicationOrigin: string): Request {
  const headers = appendIncomingHeaders(request);
  const body = requestBody(request, headers);
  return new Request(new URL(request.raw.url ?? request.url, applicationOrigin), {
    method: request.method,
    headers,
    redirect: "manual",
    ...(body === undefined ? {} : { body }),
  });
}

async function sendWebResponse(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  const setCookies = response.headers.getSetCookie();
  for (const [name, value] of response.headers.entries()) {
    if (name === "set-cookie" || name === "content-length" || name === "transfer-encoding") {
      continue;
    }
    void reply.header(name, value);
  }
  if (setCookies.length > 0) void reply.header("set-cookie", setCookies);
  const bytes = Buffer.from(await response.arrayBuffer());
  return reply.code(response.status).send(bytes);
}

function isOAuthCallbackTarget(rawTarget: string, applicationOrigin: string): boolean {
  try {
    return oauthCallbackPattern.test(new URL(rawTarget, applicationOrigin).pathname);
  } catch {
    return false;
  }
}

function cleanOAuthSuccessTarget(response: Response, applicationOrigin: string): string | null {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get("location");
  if (location === null) return null;
  try {
    const target = validateCleanSameOriginCallback(location, applicationOrigin);
    return cleanOAuthTargets.has(target) ? target : null;
  } catch {
    return null;
  }
}

function copyBetterAuthCookies(response: Response, reply: FastifyReply): void {
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) void reply.header("set-cookie", cookies);
}

function setProviderFailureCookie(reply: FastifyReply, applicationOrigin: string): void {
  const secure = new URL(applicationOrigin).protocol === "https:";
  const name = secure ? "__Secure-esmii.auth-result" : "esmii.auth-result";
  void reply.header(
    "set-cookie",
    `${name}=provider_failed; Path=/api/auth/result; HttpOnly; SameSite=Lax; Max-Age=${authResultCookieLifetimeSeconds}${secure ? "; Secure" : ""}`,
  );
}

function sendCleanOAuthRedirect(reply: FastifyReply, target: string): FastifyReply {
  return reply
    .code(303)
    .header("location", target)
    .header("cache-control", "no-store")
    .header("pragma", "no-cache")
    .header("referrer-policy", "no-referrer")
    .send();
}

async function sendOAuthCallbackResponse(
  reply: FastifyReply,
  response: Response,
  applicationOrigin: string,
): Promise<FastifyReply> {
  const target = cleanOAuthSuccessTarget(response, applicationOrigin);
  if (target === null) {
    setProviderFailureCookie(reply, applicationOrigin);
    return sendCleanOAuthRedirect(reply, "/sign-in/result");
  }
  copyBetterAuthCookies(response, reply);
  return sendCleanOAuthRedirect(reply, target);
}

/**
 * Mounts only the narrow Better Auth surface approved for the public runtime.
 * Application-owned auth, session, account, and organization routes never reach
 * the stock handler.
 */
export function registerBetterAuthRoutes(
  app: FastifyInstance,
  dependencies: BetterAuthFastifyDependencies,
): void {
  const applicationOrigin = normalizeApplicationOrigin(dependencies.applicationOrigin);
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const disposition = classifyPublicAuthRoute(request.method, request.raw.url ?? request.url);
      if (disposition !== "better-auth") {
        return reply.code(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Resource not found",
            requestId: request.id,
          },
        });
      }
      const rawTarget = request.raw.url ?? request.url;
      const callback = isOAuthCallbackTarget(rawTarget, applicationOrigin);
      let response: Response;
      try {
        response = await dependencies.auth.handler(toBetterAuthRequest(request, applicationOrigin));
      } catch (error) {
        if (!callback) throw error;
        setProviderFailureCookie(reply, applicationOrigin);
        return sendCleanOAuthRedirect(reply, "/sign-in/result");
      }
      if (callback) return sendOAuthCallbackResponse(reply, response, applicationOrigin);
      return sendWebResponse(reply, response);
    },
  });
}

export class BetterAuthAuthenticationSeam implements AuthenticationSeam {
  readonly #auth: Pick<EsmiiAuth, "api">;

  public constructor(auth: Pick<EsmiiAuth, "api">) {
    this.#auth = auth;
  }

  public async authenticate(input: {
    cookieHeader?: string;
    requestId: string;
  }): Promise<AuthenticatedPrincipal | null> {
    if (input.cookieHeader === undefined || input.cookieHeader.length === 0) return null;
    try {
      const result = await this.#auth.api.getSession({
        headers: new Headers({ cookie: input.cookieHeader }),
      });
      const session = result?.session as { id?: unknown; userId?: unknown } | undefined;
      if (typeof session?.id !== "string" || typeof session.userId !== "string") return null;
      return { sessionId: session.id, userId: session.userId };
    } catch {
      return null;
    }
  }
}
