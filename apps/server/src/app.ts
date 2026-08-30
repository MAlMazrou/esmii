import {
  DependenciesHealthResponseSchema,
  ErrorResponseSchema,
  LiveHealthResponseSchema,
  ReadyHealthResponseSchema,
  type ErrorResponse,
} from "@esmii/contracts";
import Fastify, { type FastifyInstance } from "fastify";

import { registerBetterAuthRoutes, type BetterAuthFastifyDependencies } from "./auth/fastify.js";
import {
  registerDevelopmentMockAuthRoute,
  type DevelopmentMockRouteDependencies,
} from "./auth/mock-routes.js";
import {
  registerActionLinkRoutes,
  type ActionLinkRouteDependencies,
} from "./http/action-link-routes.js";
import {
  checkDependencies,
  isReady,
  type DependencyProbe,
  validateDependencyProbes,
} from "./health/dependencies.js";
import { hasValidOperationsToken } from "./health/token.js";
import { applicationLogRedactionPaths, serializeRequestForLog } from "./observability/logger.js";
import {
  AccountHttpError,
  registerAccountRoutes,
  type AccountHttpDependencies,
} from "./http/account-routes.js";

export interface BuildAppOptions {
  actionLinks?: ActionLinkRouteDependencies;
  betterAuth?: BetterAuthFastifyDependencies;
  dependencyProbes?: readonly DependencyProbe[];
  logger?: boolean;
  mockAuth?: DevelopmentMockRouteDependencies;
  operationsHealthToken: string;
  account?: AccountHttpDependencies;
  trustedProxyIp?: string;
}

function errorResponse(code: string, message: string, requestId: string): ErrorResponse {
  return { error: { code, message, requestId } };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  if (
    options.operationsHealthToken.length < 32 ||
    options.operationsHealthToken.length > 512 ||
    /\s/.test(options.operationsHealthToken)
  ) {
    throw new TypeError("operationsHealthToken must contain 32 to 512 non-whitespace characters");
  }

  const dependencyProbes = options.dependencyProbes ?? [];
  validateDependencyProbes(dependencyProbes);

  const trustedProxy = options.trustedProxyIp;
  const app = Fastify({
    bodyLimit: 1_048_576,
    logger:
      options.logger === false
        ? false
        : {
            level: "info",
            redact: {
              censor: "[REDACTED]",
              paths: [...applicationLogRedactionPaths],
            },
            serializers: { req: serializeRequestForLog },
          },
    requestTimeout: 15_000,
    trustProxy:
      trustedProxy === undefined ? false : (address: string): boolean => address === trustedProxy,
  });

  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("Cache-Control", "no-store");
    void reply.header("X-Content-Type-Options", "nosniff");
    if (
      request.url.startsWith("/api/auth/") ||
      request.url === "/api/auth" ||
      request.url.startsWith("/api/invitation")
    ) {
      void reply.header("Referrer-Policy", "no-referrer");
      void reply.header("Pragma", "no-cache");
      void reply.header(
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
    }
    return payload;
  });

  app.get(
    "/api/health/live",
    {
      schema: {
        response: { 200: LiveHealthResponseSchema },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  if (options.account !== undefined) {
    registerAccountRoutes(app, options.account);
  }
  if (options.actionLinks !== undefined) {
    registerActionLinkRoutes(app, options.actionLinks);
  }
  if (options.mockAuth !== undefined) {
    registerDevelopmentMockAuthRoute(app, options.mockAuth);
  }
  if (options.betterAuth !== undefined) {
    registerBetterAuthRoutes(app, options.betterAuth);
  }

  app.get(
    "/api/health/ready",
    {
      schema: {
        response: {
          200: ReadyHealthResponseSchema,
          503: ReadyHealthResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const requiredProbes = dependencyProbes.filter((probe) => probe.requiredForReadiness);
      const health = await checkDependencies(requiredProbes);
      if (!isReady(requiredProbes, health)) {
        return reply.code(503).send({ status: "not_ready" });
      }

      return { status: "ready" as const };
    },
  );

  app.get(
    "/api/health/dependencies",
    {
      schema: {
        response: {
          200: DependenciesHealthResponseSchema,
          401: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!hasValidOperationsToken(request.headers.authorization, options.operationsHealthToken)) {
        void reply.header("WWW-Authenticate", "Bearer");
        return reply.code(401).send(errorResponse("UNAUTHORIZED", "Not authorized", request.id));
      }

      return checkDependencies(dependencyProbes);
    },
  );

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send(errorResponse("NOT_FOUND", "Resource not found", request.id));
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AccountHttpError) {
      return reply
        .code(error.statusCode)
        .send(errorResponse(error.code, error.safeMessage, request.id));
    }
    const validation = error as { validation?: unknown };
    if (validation.validation !== undefined) {
      return reply
        .code(400)
        .send(errorResponse("INVALID_REQUEST", "The request is invalid", request.id));
    }
    const errorName = error instanceof Error ? error.name : "UnknownError";
    request.log.error({ errorName, requestId: request.id }, "Request failed");
    return reply.code(500).send(errorResponse("INTERNAL_ERROR", "Request failed", request.id));
  });

  return app;
}
