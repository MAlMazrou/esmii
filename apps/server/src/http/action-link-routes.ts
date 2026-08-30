import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { AppEnvironment } from "@esmii/config";
import {
  createInvitationContinuation,
  lockUsableActionIntent,
  markActionIntentConsumed,
  withTransaction,
  type DatabaseClient,
} from "@esmii/database";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { hashActionToken } from "../action-links/derivation.js";
import type { EsmiiAuth } from "../auth/create-auth.js";
import { toBetterAuthRequest } from "../auth/fastify.js";
import type { AuthResultState } from "./account-routes.js";

const continuationLifetimeMilliseconds = 10 * 60 * 1_000;
const localContinuationCookie = "esmii.invitation";
const secureContinuationCookie = "__Host-esmii.invitation";
const localAuthResultCookie = "esmii.auth-result";
const secureAuthResultCookie = "__Host-esmii.auth-result";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

export interface InvitationContinuationPresentation {
  continuationId: string;
  presentedSecretHash: string;
}

export interface ActionLinkRouteDependencies {
  auth: Pick<EsmiiAuth, "handler">;
  database: Pick<DatabaseClient, "pool">;
  environment: AppEnvironment;
  publicOrigin: string;
}

function cookieName(environment: AppEnvironment): string {
  return environment === "staging" || environment === "production"
    ? secureContinuationCookie
    : localContinuationCookie;
}

function authResultCookieName(environment: AppEnvironment): string {
  return environment === "staging" || environment === "production"
    ? secureAuthResultCookie
    : localAuthResultCookie;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

export function parseInvitationContinuationCookie(
  cookieHeader: string | undefined,
  environment: AppEnvironment,
): InvitationContinuationPresentation | null {
  const value = cookieValue(cookieHeader, cookieName(environment));
  if (value === null) return null;
  const separator = value.indexOf(".");
  if (separator < 1 || value.indexOf(".", separator + 1) !== -1) return null;
  const continuationId = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  if (!uuidPattern.test(continuationId) || !tokenPattern.test(secret)) return null;
  return {
    continuationId,
    presentedSecretHash: createHash("sha256").update(secret, "utf8").digest("hex"),
  };
}

const authResultStates = new Set<AuthResultState>([
  "expired",
  "invalid",
  "provider_cancelled",
  "provider_failed",
  "superseded",
  "unsafe_link_rejected",
  "used",
]);

export function parseAuthResultCookie(
  cookieHeader: string | undefined,
  environment: AppEnvironment,
): AuthResultState {
  const value = cookieValue(cookieHeader, authResultCookieName(environment));
  return value !== null && authResultStates.has(value as AuthResultState)
    ? (value as AuthResultState)
    : "invalid";
}

export function setAuthResultCookie(
  reply: FastifyReply,
  environment: AppEnvironment,
  state: AuthResultState,
): void {
  const secure = environment === "staging" || environment === "production";
  void reply.header(
    "Set-Cookie",
    `${authResultCookieName(environment)}=${state}; Path=/api/auth/result; HttpOnly; SameSite=Lax; Max-Age=120${secure ? "; Secure" : ""}`,
  );
}

function setContinuationCookie(
  reply: FastifyReply,
  environment: AppEnvironment,
  value: string,
): void {
  const secure = environment === "staging" || environment === "production";
  void reply.header(
    "Set-Cookie",
    `${cookieName(environment)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(continuationLifetimeMilliseconds / 1_000)}${secure ? "; Secure" : ""}`,
  );
}

function redirectClean(reply: FastifyReply, path: "/app" | "/invitation" | "/sign-in/result") {
  return reply.code(303).header("Location", path).send();
}

function presentedAction(request: FastifyRequest): { intentId: string; token: string } | null {
  const query = request.query as Record<string, unknown>;
  const intentId = query.intent;
  const token = query.token;
  if (
    typeof intentId !== "string" ||
    typeof token !== "string" ||
    !uuidPattern.test(intentId) ||
    !tokenPattern.test(token)
  ) {
    return null;
  }
  return { intentId, token };
}

function copyAuthCookies(source: Response, reply: FastifyReply): void {
  const cookies = source.headers.getSetCookie();
  if (cookies.length > 0) void reply.header("Set-Cookie", cookies);
}

function isCleanSuccessfulAuthRedirect(response: Response, publicOrigin: string): boolean {
  if (response.status < 300 || response.status >= 400) return false;
  const location = response.headers.get("location");
  if (location === null) return false;
  try {
    const target = new URL(location, publicOrigin);
    return (
      target.origin === new URL(publicOrigin).origin &&
      target.pathname === "/app" &&
      target.search === "" &&
      target.hash === ""
    );
  } catch {
    return false;
  }
}

export function registerActionLinkRoutes(
  app: FastifyInstance,
  dependencies: ActionLinkRouteDependencies,
): void {
  app.get("/api/auth/magic-link/verify", async (request, reply) => {
    const action = presentedAction(request);
    if (action === null) {
      setAuthResultCookie(reply, dependencies.environment, "invalid");
      return redirectClean(reply, "/sign-in/result");
    }
    try {
      const response = await withTransaction(dependencies.database.pool, async (transaction) => {
        const intent = await lockUsableActionIntent(transaction, {
          environment: dependencies.environment,
          intentId: action.intentId,
          presentedTokenHash: hashActionToken(action.token),
          purpose: "magic_login",
        });
        if (intent === null) return null;

        const forwarded = toBetterAuthRequest(request, dependencies.publicOrigin);
        const url = new URL(forwarded.url);
        url.searchParams.delete("intent");
        url.searchParams.set("callbackURL", "/app");
        const authResponse = await dependencies.auth.handler(
          new Request(url, { headers: forwarded.headers, method: "GET", redirect: "manual" }),
        );
        if (!isCleanSuccessfulAuthRedirect(authResponse, dependencies.publicOrigin)) return null;
        if (
          !(await markActionIntentConsumed(transaction, action.intentId, {
            purpose: "magic_login",
          }))
        ) {
          throw new Error("magic-link intent changed before consumption");
        }
        return authResponse;
      });
      if (response === null) {
        setAuthResultCookie(reply, dependencies.environment, "invalid");
        return redirectClean(reply, "/sign-in/result");
      }
      copyAuthCookies(response, reply);
      return redirectClean(reply, "/app");
    } catch {
      setAuthResultCookie(reply, dependencies.environment, "invalid");
      return redirectClean(reply, "/sign-in/result");
    }
  });

  app.get("/api/invitation/exchange", async (request, reply) => {
    const action = presentedAction(request);
    if (action === null) return redirectClean(reply, "/invitation");
    try {
      const continuationId = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + continuationLifetimeMilliseconds);
      const created = await withTransaction(dependencies.database.pool, async (transaction) => {
        const intent = await lockUsableActionIntent(transaction, {
          environment: dependencies.environment,
          intentId: action.intentId,
          presentedTokenHash: hashActionToken(action.token),
          purpose: "invitation_accept",
        });
        if (intent?.invitationId === null || intent?.invitationId === undefined) return false;
        await createInvitationContinuation(transaction, {
          actionIntentId: action.intentId,
          expiresAt,
          id: continuationId,
          invitationId: intent.invitationId,
          secretHash: createHash("sha256").update(secret, "utf8").digest("hex"),
        });
        return true;
      });
      if (created)
        setContinuationCookie(reply, dependencies.environment, `${continuationId}.${secret}`);
      return redirectClean(reply, "/invitation");
    } catch {
      return redirectClean(reply, "/invitation");
    }
  });
}
