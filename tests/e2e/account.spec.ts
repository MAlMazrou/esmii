import { expect, test, type Page } from "@playwright/test";

// End-to-end coverage for the account and organization experience.

interface MailpitMessageSummary {
  ID: string;
  To: Array<{ Address: string }>;
}

async function openMagicLinkSession(page: Page, email: string): Promise<void> {
  const beforeResponse = await page.context().request.get("http://127.0.0.1:8025/api/v1/messages");
  const before = (await beforeResponse.json()) as { messages?: MailpitMessageSummary[] };
  const existingMessageIds = new Set((before.messages ?? []).map((message) => message.ID));

  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  await expect
    .poll(
      async () => {
        const response = await page.context().request.get("http://127.0.0.1:8025/api/v1/messages");
        if (!response.ok()) return null;
        const payload = (await response.json()) as { messages?: MailpitMessageSummary[] };
        return (
          payload.messages?.find(
            (message) =>
              message.To.some((recipient) => recipient.Address === email) &&
              !existingMessageIds.has(message.ID),
          )?.ID ?? null
        );
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();

  const messages = await page.context().request.get("http://127.0.0.1:8025/api/v1/messages");
  const list = (await messages.json()) as { messages: MailpitMessageSummary[] };
  const id = list.messages.find(
    (message) =>
      message.To.some((recipient) => recipient.Address === email) &&
      !existingMessageIds.has(message.ID),
  )?.ID;
  expect(id).toBeTruthy();
  const message = await page
    .context()
    .request.get(`http://127.0.0.1:8025/api/v1/message/${encodeURIComponent(id ?? "")}`);
  const detail = (await message.json()) as { Text: string };
  const actionUrl = detail.Text.match(/https?:\/\/[^\s]+/u)?.[0];
  expect(actionUrl).toBeTruthy();

  await page.goto(actionUrl ?? "/sign-in");
  await page.waitForURL(/\/app(?:\/onboarding)?$/u);
}

async function createOrganization(page: Page, displayName: string): Promise<void> {
  await page.goto("/app/organizations");
  await page.getByRole("button", { name: "Create organization" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create organization" });
  await dialog.getByLabel("Organization name").fill(displayName);
  await dialog.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(/\/app(?:\/onboarding)?$/u);
  await page.goto("/app/organizations");
  const organizationCard = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: displayName }) });
  await expect(organizationCard).toBeVisible();
  const switchButton = organizationCard.getByRole("button", { name: "Switch and open" });
  if ((await switchButton.count()) > 0) await switchButton.click();
  else await page.goto("/app");
  await page.waitForURL(/\/app$/u);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

test("routes an unauthenticated visitor to the passwordless sign-in surface", async ({ page }) => {
  await page.goto("/");
  await page.waitForURL(/\/sign-in$/u);
  await expect(page.getByText("Esmii", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to Esmii" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Microsoft/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Apple/u })).toHaveCount(0);
});

test("has no horizontal overflow on the sign-in surface", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Esmii" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
});

test("signs in locally, creates and switches organizations, and delivers an invitation", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "reference-chromium", "Run the stateful flow once.");
  test.setTimeout(60_000);
  const suffix = `${Date.now()}-${testInfo.retry}`;
  const firstOrganization = `E2E North ${suffix}`;
  const secondOrganization = `E2E South ${suffix}`;
  const userEmail = `user-${suffix}@example.invalid`;
  const inviteEmail = `invite-${suffix}@example.invalid`;

  await openMagicLinkSession(page, userEmail);

  const requestLink = async (email: string, label: "existing" | "unknown") =>
    page.context().request.post("/api/auth/magic-link/request", {
      data: { email },
      headers: { "Idempotency-Key": `e2e-magic-link:${suffix}:${label}` },
    });
  const existingResponse = await requestLink(userEmail, "existing");
  const unknownResponse = await requestLink(`unknown-${suffix}@example.invalid`, "unknown");
  expect(existingResponse.status()).toBe(202);
  expect(unknownResponse.status()).toBe(202);
  expect(await existingResponse.json()).toEqual(await unknownResponse.json());

  await createOrganization(page, firstOrganization);
  await createOrganization(page, secondOrganization);

  await page.goto("/app/organizations");
  await expect(page.getByRole("heading", { name: firstOrganization })).toBeVisible();
  await expect(page.getByRole("heading", { name: secondOrganization })).toBeVisible();

  const firstCard = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: firstOrganization }) });
  const switchButton = firstCard.getByRole("button", { name: "Switch and open" });
  if ((await switchButton.count()) > 0) {
    await switchButton.click();
    await page.waitForURL(/\/app$/u);
  }
  await expect(page.getByRole("heading", { name: firstOrganization })).toBeVisible();

  await page.goto("/app/members");
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  await expect(
    page.getByLabel("Organization members").getByText(userEmail, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Invite member" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite member" });
  await dialog.getByLabel("Email address").fill(inviteEmail);
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("Invitation sent.", { exact: true })).toBeVisible();
  await expect(page.getByText(inviteEmail, { exact: true })).toBeVisible();

  await expect
    .poll(
      async () => {
        const response = await page.context().request.get("http://127.0.0.1:8025/api/v1/messages");
        return response.ok() ? await response.text() : "";
      },
      { timeout: 30_000 },
    )
    .toContain(inviteEmail);

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
});

test("exposes minimal public health responses", async ({ request }) => {
  const live = await request.get("/api/health/live");
  expect(live.ok()).toBe(true);
  expect(await live.json()).toEqual({ status: "ok" });

  const dependencies = await request.get("/api/health/dependencies");
  expect(dependencies.status()).toBe(401);
});

test("denies private and malformed media paths at the Caddy boundary", async ({ request }) => {
  const deniedPaths = [
    ["private media path", "/media/private/originals/example.webp"],
    ["hidden dot path", "/media/.hidden"],
    ["encoded traversal-like path", "/media/%252e%252e%252fprivate%252foriginal.webp"],
    ["non-content-hash path", "/media/ab/cd/example.webp"],
  ] as const;

  for (const [caseName, path] of deniedPaths) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), `${caseName}: ${path}`).toBe(404);
  }
});
