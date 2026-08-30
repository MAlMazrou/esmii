import type { AppEnvironment } from "@esmii/config";
import {
  getViewerContext,
  inspectInvitationContinuation,
  type DatabaseClient,
} from "@esmii/database";
import type { FastifyRequest } from "fastify";

import type { AuthenticatedPrincipal } from "../account/seams.js";
import {
  parseAuthResultCookie,
  type InvitationContinuationPresentation,
} from "../http/action-link-routes.js";
import type { ActionExchangeSeam } from "./account-service.js";

export class PostgresActionExchangeSeam implements ActionExchangeSeam {
  readonly #environment: AppEnvironment;
  readonly #pool: DatabaseClient["pool"];

  public constructor(input: { environment: AppEnvironment; pool: DatabaseClient["pool"] }) {
    this.#environment = input.environment;
    this.#pool = input.pool;
  }

  public async getAuthResult(request: FastifyRequest) {
    return { state: parseAuthResultCookie(request.headers.cookie, this.#environment) };
  }

  public async getInvitation(
    principal: AuthenticatedPrincipal | null,
    _request: FastifyRequest,
    continuation: InvitationContinuationPresentation | null,
  ) {
    if (continuation === null) return { state: "expired" as const };
    const invitation = await inspectInvitationContinuation(this.#pool, continuation);
    if (invitation === null) return { state: "consumed" as const };
    const context = {
      organization: { displayName: invitation.organization.displayName },
      role: invitation.role,
    } as const;
    if (invitation.organization.deleted) {
      return { ...context, state: "organization_deleted" as const };
    }
    if (invitation.status === "accepted") return { ...context, state: "accepted" as const };
    if (
      invitation.status === "revoked" ||
      invitation.status === "canceled" ||
      invitation.status === "rejected"
    ) {
      return { ...context, state: "revoked" as const };
    }
    if (invitation.status === "expired" || invitation.expiresAt.getTime() <= Date.now()) {
      return { ...context, state: "expired" as const };
    }
    if (principal === null) return { ...context, state: "needs_authentication" as const };
    const viewer = await getViewerContext(this.#pool, principal);
    if (viewer === null || !viewer.emailVerified) {
      return { ...context, state: "needs_authentication" as const };
    }
    if (viewer.email !== invitation.email) return { ...context, state: "wrong_email" as const };
    return { ...context, state: "ready" as const };
  }
}
