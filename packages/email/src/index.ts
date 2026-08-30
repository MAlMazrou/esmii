import nodemailer, { type Transporter } from "nodemailer";

export interface EmailRecipient {
  address: string;
  displayName?: string;
}

export interface EmailMessage {
  from?: EmailRecipient;
  html?: string;
  messageId: string;
  subject: string;
  text: string;
  to: EmailRecipient;
}

export interface EmailDeliveryReceipt {
  acceptedAt: Date;
  messageId: string;
  transportReference?: string;
}

export interface EmailTransport {
  send(message: Readonly<EmailMessage>): Promise<EmailDeliveryReceipt>;
}

export interface EmailTemplate {
  html: string;
  subject: string;
  text: string;
}

export interface ActionEmailTemplateInput {
  actionUrl: URL;
  applicationName?: string;
  recipientName?: string;
}

export interface InvitationEmailTemplateInput extends ActionEmailTemplateInput {
  inviterName?: string;
  organizationName: string;
  role: "editor" | "member";
}

export interface SecurityNotificationTemplateInput {
  action: string;
  applicationName?: string;
  organizationName?: string;
  recipientName?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function greeting(recipientName?: string): string {
  return recipientName === undefined ? "Hello," : `Hello ${recipientName},`;
}

function renderActionButton(label: string, actionUrl: URL): string {
  const url = escapeHtml(actionUrl.toString());
  return `<p><a href="${url}" style="display:inline-block;background:#2457f5;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(label)}</a></p>`;
}

function renderShell(applicationName: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(applicationName)}</title></head><body style="margin:0;background:#f6f4ef;color:#151515;font-family:Arial,sans-serif"><main style="max-width:600px;margin:0 auto;padding:32px 20px"><p style="font-size:20px;font-weight:700">${escapeHtml(applicationName)}</p>${content}<hr style="border:0;border-top:1px solid #d8d4ca;margin:28px 0"><p style="font-size:13px;color:#666">If you did not request this, you can ignore this email.</p></main></body></html>`;
}

export function renderMagicLinkEmail(input: ActionEmailTemplateInput): EmailTemplate {
  const applicationName = input.applicationName ?? "Esmii";
  const hello = greeting(input.recipientName);
  const text = [
    hello,
    "",
    `Use this secure link to sign in to ${applicationName}:`,
    input.actionUrl.toString(),
    "",
    "This link expires in 10 minutes and can be used once.",
    "If you did not request this, you can ignore this email.",
  ].join("\n");
  const html = renderShell(
    applicationName,
    `<p>${escapeHtml(hello)}</p><p>Use this secure link to sign in. It expires in 10 minutes and can be used once.</p>${renderActionButton("Sign in to Esmii", input.actionUrl)}`,
  );
  return { html, subject: `Sign in to ${applicationName}`, text };
}

export function renderInvitationEmail(input: InvitationEmailTemplateInput): EmailTemplate {
  const applicationName = input.applicationName ?? "Esmii";
  const hello = greeting(input.recipientName);
  const inviter = input.inviterName === undefined ? "A member" : input.inviterName;
  const text = [
    hello,
    "",
    `${inviter} invited you to join ${input.organizationName} as ${input.role}.`,
    "Sign in with this exact email address, then accept the invitation:",
    input.actionUrl.toString(),
    "",
    "This invitation expires in 7 days and can be accepted once.",
  ].join("\n");
  const html = renderShell(
    applicationName,
    `<p>${escapeHtml(hello)}</p><p>${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(input.organizationName)}</strong> as ${escapeHtml(input.role)}. Sign in with this exact email address before accepting.</p>${renderActionButton("Review invitation", input.actionUrl)}<p>This invitation expires in 7 days and can be accepted once.</p>`,
  );
  return { html, subject: `Invitation to ${input.organizationName}`, text };
}

export function renderSecurityNotificationEmail(
  input: SecurityNotificationTemplateInput,
): EmailTemplate {
  const applicationName = input.applicationName ?? "Esmii";
  const hello = greeting(input.recipientName);
  const scope = input.organizationName === undefined ? "your account" : input.organizationName;
  const sentence = `${input.action} for ${scope}.`;
  const text = [
    hello,
    "",
    sentence,
    "",
    `If you do not recognize this change, sign in to ${applicationName} and review your active sessions.`,
  ].join("\n");
  const html = renderShell(
    applicationName,
    `<p>${escapeHtml(hello)}</p><p>${escapeHtml(sentence)}</p><p>If you do not recognize this change, sign in and review your active sessions.</p>`,
  );
  return { html, subject: `${applicationName} security notification`, text };
}

/** Safe local/test seam. It never opens a network connection. */
export class CapturedEmailTransport implements EmailTransport {
  readonly #clock: () => Date;
  readonly #maximumMessages: number;
  readonly #messages: EmailMessage[] = [];

  public constructor(options: { clock?: () => Date; maximumMessages?: number } = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#maximumMessages = options.maximumMessages ?? 200;
    if (!Number.isSafeInteger(this.#maximumMessages) || this.#maximumMessages < 1) {
      throw new TypeError("maximumMessages must be a positive integer");
    }
  }

  public get messages(): readonly Readonly<EmailMessage>[] {
    return this.#messages.map((message) => ({
      ...message,
      ...(message.from === undefined ? {} : { from: { ...message.from } }),
      to: { ...message.to },
    }));
  }

  public clear(): void {
    this.#messages.splice(0, this.#messages.length);
  }

  public async send(message: Readonly<EmailMessage>): Promise<EmailDeliveryReceipt> {
    const captured: EmailMessage = {
      messageId: message.messageId,
      subject: message.subject,
      text: message.text,
      to: { ...message.to },
      ...(message.from === undefined ? {} : { from: { ...message.from } }),
      ...(message.html === undefined ? {} : { html: message.html }),
    };
    this.#messages.push(captured);
    if (this.#messages.length > this.#maximumMessages) this.#messages.shift();
    return {
      acceptedAt: this.#clock(),
      messageId: message.messageId,
      transportReference: `capture:${this.#messages.length}`,
    };
  }
}

export interface SmtpEmailTransportOptions {
  defaultFrom: EmailRecipient;
  smtpUrl: string;
  transporter?: Transporter;
}

/** SMTP is called only by the worker; API request handlers never receive this transport. */
export class SmtpEmailTransport implements EmailTransport {
  readonly #defaultFrom: EmailRecipient;
  readonly #transporter: Transporter;

  public constructor(options: SmtpEmailTransportOptions) {
    this.#defaultFrom = { ...options.defaultFrom };
    this.#transporter = options.transporter ?? nodemailer.createTransport(options.smtpUrl);
  }

  public async send(message: Readonly<EmailMessage>): Promise<EmailDeliveryReceipt> {
    const from = message.from ?? this.#defaultFrom;
    const information = await this.#transporter.sendMail({
      from:
        from.displayName === undefined
          ? from.address
          : { address: from.address, name: from.displayName },
      to:
        message.to.displayName === undefined
          ? message.to.address
          : { address: message.to.address, name: message.to.displayName },
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
      messageId: message.messageId,
    });
    return {
      acceptedAt: new Date(),
      messageId: message.messageId,
      ...(typeof information.messageId === "string"
        ? { transportReference: information.messageId }
        : {}),
    };
  }

  public async close(): Promise<void> {
    this.#transporter.close();
  }
}
