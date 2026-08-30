import { randomUUID } from "node:crypto";

import type { AppEnvironment, AuthProviderId } from "@esmii/config";
import type { DatabaseClient } from "@esmii/database";
import type { FastifyInstance } from "fastify";
import Type from "typebox";
import type { TestHelpers } from "better-auth/plugins";

import type { EsmiiAuth } from "./create-auth.js";
import { createDevelopmentMockProvider } from "./mock-provider.js";

const MockRequestSchema = Type.Object(
  {
    provider: Type.Union([Type.Literal("google"), Type.Literal("microsoft")]),
    scenario: Type.Union([
      Type.Literal("success"),
      Type.Literal("existing"),
      Type.Literal("missing-email"),
      Type.Literal("provider-error"),
      Type.Literal("unverified-email"),
    ]),
  },
  { additionalProperties: false },
);

export interface DevelopmentMockRouteDependencies {
  auth: Pick<EsmiiAuth, "$context">;
  database: Pick<DatabaseClient, "pool">;
  environment: AppEnvironment;
  mockProviders: readonly Exclude<AuthProviderId, "apple">[];
}

export function registerDevelopmentMockAuthRoute(
  app: FastifyInstance,
  dependencies: DevelopmentMockRouteDependencies,
): void {
  if (dependencies.environment !== "development" && dependencies.environment !== "test") return;

  app.post<{
    Body: {
      provider: "google" | "microsoft";
      scenario: "existing" | "missing-email" | "provider-error" | "success" | "unverified-email";
    };
  }>("/api/auth/mock-social", { schema: { body: MockRequestSchema } }, async (request, reply) => {
    if (!dependencies.mockProviders.includes(request.body.provider)) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "Resource not found", requestId: request.id },
      });
    }
    const mock = createDevelopmentMockProvider(dependencies.environment);
    let identity;
    try {
      identity = mock.resolveScenario(
        request.body.scenario === "success"
          ? "verified-new-user"
          : request.body.scenario === "existing"
            ? "verified-existing-user"
            : request.body.scenario,
      );
    } catch {
      return reply.code(502).send({
        error: {
          code: "MOCK_PROVIDER_FAILED",
          message: "The local provider did not complete sign-in.",
          requestId: request.id,
        },
      });
    }
    if (identity.email === null || !identity.emailVerified) {
      return reply.code(403).send({
        error: {
          code: "IDENTITY_NOT_ALLOWED",
          message: "This provider identity cannot be used.",
          requestId: request.id,
        },
      });
    }

    const context = (await dependencies.auth.$context) as { test?: TestHelpers };
    if (context.test === undefined) throw new Error("local Better Auth helpers are unavailable");
    const existing = await dependencies.database.pool.query<{ id: string }>(
      "SELECT id FROM app.\"user\" WHERE email = $1 AND status = 'active'",
      [identity.email],
    );
    let userId = existing.rows[0]?.id;
    if (userId === undefined) {
      const user = context.test.createUser({
        email: identity.email,
        emailVerified: true,
        name: identity.name,
      });
      const inserted = await dependencies.database.pool.query<{ id: string }>(
        `INSERT INTO app."user" (id, name, email, "emailVerified")
           VALUES ($1, $2, $3, true)
           ON CONFLICT (email) DO NOTHING
           RETURNING id`,
        [user.id, user.name, user.email],
      );
      userId = inserted.rows[0]?.id;
      if (userId === undefined) {
        const concurrent = await dependencies.database.pool.query<{ id: string }>(
          `SELECT id
               FROM app."user"
              WHERE email = $1
                AND status = 'active'`,
          [identity.email],
        );
        userId = concurrent.rows[0]?.id;
      }
      if (userId === undefined) throw new Error("local mock user could not be created");
    }
    await dependencies.database.pool.query(
      `INSERT INTO app.account (
           id, issuer, "accountId", "providerId", "userId"
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (issuer, "accountId") DO NOTHING`,
      [
        randomUUID(),
        `esmii-local-mock:${request.body.provider}`,
        identity.providerAccountId,
        request.body.provider,
        userId,
      ],
    );
    const login = await context.test.login({ userId });
    const sessionCookie = login.headers.get("cookie");
    if (sessionCookie === null)
      throw new Error("local Better Auth login returned no session cookie");
    void reply.header("Set-Cookie", `${sessionCookie}; Path=/; HttpOnly; SameSite=Lax`);
    return { redirectUrl: "/app" };
  });
}
