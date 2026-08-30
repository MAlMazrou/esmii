import { createHmac } from "node:crypto";

import { getActionLinkKey, type ActionLinkKeyring, type AppEnvironment } from "@esmii/config";
import type { DatabaseClient } from "@esmii/database";
import { renderMagicLinkEmail, type EmailDeliveryReceipt, type EmailTransport } from "@esmii/email";

import { createAuth, issueWorkerMagicLink, type EsmiiAuth } from "../auth/create-auth.js";
import type { MagicLinkIssuer } from "./action-link-worker.js";

function deriveWorkerAuthInstanceSecret(keyring: ActionLinkKeyring): string {
  const key = getActionLinkKey(keyring, "magic-link");
  return createHmac("sha256", key.key)
    .update("esmii-worker-better-auth-instance-v1", "utf8")
    .digest("base64url");
}

export interface WorkerAuthBoundary {
  auth: EsmiiAuth;
  issuer: MagicLinkIssuer;
}

/**
 * Creates the worker-only Better Auth issuance boundary. The generated raw link
 * exists only long enough to render and submit one SMTP message.
 */
export function createWorkerAuthBoundary(input: {
  database: DatabaseClient;
  emailTransport: EmailTransport;
  environment: AppEnvironment;
  keyring: ActionLinkKeyring;
  publicOrigin: string;
}): WorkerAuthBoundary {
  const receipts = new Map<string, EmailDeliveryReceipt>();
  const auth = createAuth({
    applicationOrigin: input.publicOrigin,
    authSecret: deriveWorkerAuthInstanceSecret(input.keyring),
    deploymentMode: input.environment,
    async deliverMagicLink(message) {
      const actionUrl = new URL(message.url);
      actionUrl.searchParams.set("intent", message.intentId);
      const template = renderMagicLinkEmail({ actionUrl });
      const receipt = await input.emailTransport.send({
        html: template.html,
        messageId: message.stableMessageId,
        subject: template.subject,
        text: template.text,
        to: { address: message.email },
      });
      receipts.set(message.stableMessageId, receipt);
    },
    pool: input.database.pool,
    runtimeRole: "worker",
    sessionPolicy: {
      expiresInSeconds: 30 * 24 * 60 * 60,
      freshAgeSeconds: 10 * 60,
      updateAgeSeconds: 24 * 60 * 60,
    },
    trustedOrigins: [input.publicOrigin],
    validateSocialIdentity: async () => false,
  });

  const issuer: MagicLinkIssuer = {
    async issue(message) {
      try {
        await issueWorkerMagicLink(
          auth,
          {
            approvedCallbackPath: message.approvedCallbackPath,
            expiresAt: message.expiresAt,
            intentId: message.intentId,
            keyVersion: String(message.keyVersion),
            normalizedEmail: message.canonicalEmail,
            rawToken: message.rawToken,
            stableMessageId: message.messageId,
          },
          input.publicOrigin,
        );
        const receipt = receipts.get(message.messageId);
        if (receipt === undefined) {
          throw new Error("magic-link SMTP delivery did not return a receipt");
        }
        return receipt.transportReference === undefined
          ? {}
          : { providerReference: receipt.transportReference };
      } finally {
        receipts.delete(message.messageId);
      }
    },
  };

  return { auth, issuer };
}
