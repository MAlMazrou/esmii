import { randomUUID } from "node:crypto";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import nodemailer from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOperatorEmailOtpSender } from "../lib/auth/email-otp.ts";
import type { DashboardAuthConfig } from "../lib/config/server.ts";

const files: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const file of files.splice(0)) {
    try {
      unlinkSync(file);
    } catch {
      // The test may deliberately fail before creating its capture file.
    }
  }
});

function config(captureFile: string): DashboardAuthConfig {
  return {
    databaseFile: "/private/tmp/operator-email-otp.sqlite",
    emailOtpCaptureFile: captureFile,
    emailOtpFrom: "monitoring-staging@esmii.app",
    environment: "staging",
    origin: "http://127.0.0.1:3010",
    peerOrigin: "http://127.0.0.1:3011",
    secret: "test-only-secret-material-with-more-than-thirty-two-characters",
    smtpUrl: null,
    themeFixture: null,
  };
}

describe("operator email OTP delivery", () => {
  it("writes only a mode-0600 six-digit code in the loopback capture seam", async () => {
    const captureFile = join(tmpdir(), `esmii-email-otp-${randomUUID()}`);
    files.push(captureFile);
    const send = createOperatorEmailOtpSender(config(captureFile));
    await send({
      email: "operator@example.test",
      otp: "381024",
      type: "email-verification",
    });
    expect(readFileSync(captureFile, "utf8")).toBe("381024\n");
    expect(statSync(captureFile).mode & 0o777).toBe(0o600);
  });

  it("rejects unsupported flows and malformed delivery values", async () => {
    const captureFile = join(tmpdir(), `esmii-email-otp-${randomUUID()}`);
    files.push(captureFile);
    const send = createOperatorEmailOtpSender(config(captureFile));
    await expect(
      send({ email: "operator@example.test", otp: "123456", type: "sign-in" }),
    ).rejects.toThrow(/Invalid operator email OTP/u);
    await expect(
      send({ email: "Operator@example.test", otp: "123456", type: "email-verification" }),
    ).rejects.toThrow(/Invalid operator email OTP/u);
    await expect(
      send({ email: "operator@example.test", otp: "12345", type: "email-verification" }),
    ).rejects.toThrow(/Invalid operator email OTP/u);
  });

  it("uses bounded certificate-verified STARTTLS and the fixed recipient", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "accepted" });
    const createTransport = vi
      .spyOn(nodemailer, "createTransport")
      .mockReturnValue({ sendMail } as never);
    const production: DashboardAuthConfig = {
      ...config("/private/tmp/not-used"),
      emailOtpCaptureFile: null,
      emailOtpFrom: "monitoring@esmii.app",
      environment: "production",
      origin: "https://dashboard.esmii.app",
      peerOrigin: "https://staging-dashboard.esmii.app",
      smtpUrl:
        "smtp://monitoring%40esmii.app:test-password-material-more-than-32-characters@mail.esmii.app:587?requireTLS=true",
    };
    const send = createOperatorEmailOtpSender(production);
    await send({
      email: "operator@example.test",
      otp: "381024",
      type: "email-verification",
    });

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        host: "mail.esmii.app",
        port: 587,
        requireTLS: true,
        secure: false,
        socketTimeout: 15_000,
        tls: { rejectUnauthorized: true, servername: "mail.esmii.app" },
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { address: "monitoring@esmii.app", name: "Esmii production monitoring" },
        subject: "PRODUCTION Esmii monitoring sign-in code",
        to: "operator@example.test",
      }),
    );
  });
});
