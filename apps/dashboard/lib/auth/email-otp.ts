import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import nodemailer from "nodemailer";

import type { DashboardAuthConfig } from "../config/server.ts";

export const OPERATOR_EMAIL_OTP_SECONDS = 5 * 60;
export const OPERATOR_EMAIL_OTP_LENGTH = 6;

export interface OperatorEmailOtpMessage {
  readonly email: string;
  readonly otp: string;
  readonly type: "change-email" | "email-verification" | "forget-password" | "sign-in";
}

function writeCapturedOtp(path: string, otp: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${otp}\n`, { encoding: "utf8" });
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // A successful atomic rename removes the temporary path.
    }
  }
}

export function createOperatorEmailOtpSender(
  config: DashboardAuthConfig,
): (message: OperatorEmailOtpMessage) => Promise<void> {
  const smtp = config.smtpUrl === null ? null : new URL(config.smtpUrl);
  const transporter =
    smtp === null
      ? null
      : nodemailer.createTransport({
          auth: {
            pass: decodeURIComponent(smtp.password),
            user: decodeURIComponent(smtp.username),
          },
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          host: smtp.hostname,
          port: Number(smtp.port),
          requireTLS: true,
          secure: false,
          socketTimeout: 15_000,
          tls: {
            rejectUnauthorized: true,
            servername: "mail.esmii.app",
          },
        });
  const messageDomain = new URL(config.origin).hostname;
  return async (message) => {
    if (
      message.type !== "email-verification" ||
      !/^\d{6}$/u.test(message.otp) ||
      message.email !== message.email.trim().toLowerCase()
    ) {
      throw new Error("Invalid operator email OTP delivery request");
    }
    if (config.emailOtpCaptureFile !== null) {
      writeCapturedOtp(config.emailOtpCaptureFile, message.otp);
      return;
    }
    if (transporter === null) {
      throw new Error("Operator email OTP delivery is unavailable");
    }
    const environment = config.environment.toUpperCase();
    const subject = `${environment} Esmii monitoring sign-in code`;
    const text = [
      `ESMII ${environment} · PRIVATE MONITORING`,
      "",
      `Your ${environment} Esmii monitoring sign-in code is:`,
      "",
      message.otp,
      "",
      "It expires in 5 minutes and can be used once.",
      "If you did not request this code, you can ignore this email.",
    ].join("\n");
    await transporter.sendMail({
      from: { address: config.emailOtpFrom, name: `Esmii ${config.environment} monitoring` },
      messageId: `<${randomUUID()}@${messageDomain}>`,
      subject,
      text,
      to: message.email,
    });
  };
}
