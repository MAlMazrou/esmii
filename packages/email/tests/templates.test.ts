import { describe, expect, it } from "vitest";

import {
  renderInvitationEmail,
  renderMagicLinkEmail,
  renderSecurityNotificationEmail,
} from "../src/index.js";

describe("account email templates", () => {
  it("renders text and HTML magic-link messages with the 10-minute limit", () => {
    const template = renderMagicLinkEmail({
      actionUrl: new URL("http://localhost:8080/api/auth/magic-link/verify?token=transient-test"),
      recipientName: "Synthetic User",
    });

    expect(template.text).toContain("10 minutes");
    expect(template.text).toContain("transient-test");
    expect(template.html).toContain("Sign in to Esmii");
  });

  it("escapes invitation values and states the exact-email and seven-day constraints", () => {
    const template = renderInvitationEmail({
      actionUrl: new URL("http://localhost:8080/api/invitation/exchange?token=transient-test"),
      organizationName: "Synthetic <Team>",
      role: "editor",
    });

    expect(template.text).toContain("exact email address");
    expect(template.text).toContain("7 days");
    expect(template.html).toContain("Synthetic &lt;Team&gt;");
    expect(template.html).not.toContain("Synthetic <Team>");
  });

  it("renders security notifications without a bearer link", () => {
    const template = renderSecurityNotificationEmail({
      action: "Owner access was granted",
      organizationName: "Synthetic Organization",
    });

    expect(template.text).toContain("Owner access was granted");
    expect(template.html).not.toContain("href=");
  });
});
