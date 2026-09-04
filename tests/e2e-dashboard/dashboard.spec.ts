import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  openOperatorDatabase,
  revokeOperatorSessions,
} from "../../apps/dashboard/lib/auth/database.js";

type MonitoringEnvironment = "staging" | "production";

interface FixtureMetadata {
  readonly databaseFile: string;
  readonly email: string;
  readonly emailOtpCodeFile: string;
  readonly environment: MonitoringEnvironment;
  readonly origin: string;
  readonly password: string;
  readonly peerOrigin: string;
  readonly themeFixture: "contract-test" | null;
}

const runtimeRoot = resolve(process.cwd(), "test-results/dashboard-e2e-runtime");

function readFixture(environment: MonitoringEnvironment): FixtureMetadata {
  const fixture = JSON.parse(
    readFileSync(resolve(runtimeRoot, environment, "fixture.json"), "utf8"),
  ) as FixtureMetadata;
  expect(fixture.environment).toBe(environment);
  return fixture;
}

function captureRuntimeErrors(page: Page): readonly string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  return errors;
}

async function expectAnonymousBoundary(page: Page, fixture: FixtureMetadata): Promise<void> {
  const request = page.context().request;
  const overviewApi = await request.get(`${fixture.origin}/api/monitoring/overview`);
  expect(overviewApi.status()).toBe(401);
  expect(await overviewApi.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

  const requests = [
    request.get(`${fixture.origin}/overview`, { maxRedirects: 0 }),
    request.head(`${fixture.origin}/overview`, { maxRedirects: 0 }),
    request.get(`${fixture.origin}/overview`, {
      headers: { rsc: "1" },
      maxRedirects: 0,
    }),
    request.get(`${fixture.origin}/overview`, {
      headers: { "next-router-prefetch": "1", rsc: "1" },
      maxRedirects: 0,
    }),
  ];
  for (const response of await Promise.all(requests)) {
    expect(response.status()).toBe(307);
    expect(new URL(response.headers().location ?? "/", fixture.origin).pathname).toBe("/login");
    const body = await response.text();
    expect(body).not.toMatch(/System overview|PostgreSQL|fixture-4|Prometheus/iu);
  }
}

async function signIn(page: Page, fixture: FixtureMetadata): Promise<void> {
  await expectAnonymousBoundary(page, fixture);
  await page.goto(`${fixture.origin}/overview`);
  await expect(page).toHaveURL(`${fixture.origin}/login`);
  await expect(page.getByRole("heading", { name: "Operator sign in" })).toBeVisible();
  await expect(page.getByText(`Private monitoring · ${fixture.environment}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "System overview" })).toHaveCount(0);

  await page.getByLabel("Email").fill(fixture.email);
  await page.getByLabel("Password").fill(fixture.password);
  rmSync(fixture.emailOtpCodeFile, { force: true });
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Verify it’s you" })).toBeVisible();
  const passwordOnlyApi = await page
    .context()
    .request.get(`${fixture.origin}/api/monitoring/overview`);
  expect(passwordOnlyApi.status()).toBe(401);
  const passwordOnlyPage = await page.context().request.get(`${fixture.origin}/overview`, {
    maxRedirects: 0,
  });
  expect(passwordOnlyPage.status()).toBe(307);
  expect(new URL(passwordOnlyPage.headers().location ?? "/", fixture.origin).pathname).toBe(
    "/login",
  );
  await expect(page.getByRole("status")).toContainText(fixture.email);
  const codeInput = page.getByLabel("Email code");
  await expect(codeInput).toBeFocused();
  await codeInput.fill("12345");
  await expect(page.getByRole("button", { name: "Verify and continue" })).toBeDisabled();
  await expect
    .poll(() => {
      try {
        return readFileSync(fixture.emailOtpCodeFile, "utf8").trim();
      } catch {
        return "";
      }
    })
    .toMatch(/^\d{6}$/u);
  await codeInput.fill(readFileSync(fixture.emailOtpCodeFile, "utf8").trim());
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.waitForURL(`${fixture.origin}/overview`);
  await expect(page.getByRole("heading", { name: "System overview" })).toBeVisible();
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
}

test.describe("dashboard browser acceptance", () => {
  test("authenticates the fixed production realm and preserves non-color status meaning", async ({
    page,
  }) => {
    const fixture = readFixture("production");
    const runtimeErrors = captureRuntimeErrors(page);
    await signIn(page, fixture);

    await expect(page).toHaveTitle("PRODUCTION · Esmii monitoring");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "contract-test");
    await expect(page.locator('.environment-rail[data-environment="production"]')).toHaveText(
      "PRODUCTION",
    );
    await expect(page.locator(".environment-summary strong")).toHaveText("production");
    await expect(page.locator(".operator-label")).toHaveText(fixture.email);
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator(".mobile-header")).toBeHidden();

    const theme = await page.locator(".sidebar").evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, color: style.color };
    });
    expect(theme.background).toBe("rgb(17, 20, 24)");
    expect(theme.color).toBe("rgb(255, 255, 255)");

    const response = await page.context().request.get(`${fixture.origin}/api/monitoring/overview`);
    expect(response.ok()).toBe(true);
    expect((await response.json()) as { environment: string }).toMatchObject({
      environment: "production",
    });

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Tab");
    const firstNavigationLink = page.locator('.side-nav a[href="/overview"]').first();
    await expect(firstNavigationLink).toBeFocused();
    const focusStyle = await firstNavigationLink.evaluate((element) => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    expect(focusStyle.outlineStyle).not.toBe("none");
    expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(3);

    await page.getByRole("link", { name: "Services", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Service health" })).toBeVisible();
    const status = page.locator(".service-row .status-pill").first();
    await expect(status).toContainText("healthy");
    await expect(status).toHaveAttribute("aria-label", "healthy, healthy state");
    await expect(status.locator(".status-symbol")).toHaveText("●");
    await expectNoDocumentOverflow(page);
    await expect(page.locator("nextjs-portal")).toHaveCount(0);
    expect(runtimeErrors).toEqual([]);

    await page.goto(`${fixture.peerOrigin}/overview`);
    await expect(page).toHaveURL(`${fixture.peerOrigin}/login`);
    await expect(page).toHaveTitle("STAGING · Esmii monitoring");
    await expect(page.getByText("Private monitoring · staging")).toBeVisible();

    const database = openOperatorDatabase(fixture.databaseFile);
    try {
      const operator = database
        .prepare('SELECT id FROM "user" WHERE lower(email) = ?')
        .get(fixture.email) as { readonly id: string } | undefined;
      expect(operator).toBeDefined();
      expect(revokeOperatorSessions(database, operator?.id ?? "missing")).toBeGreaterThan(0);
    } finally {
      database.close();
    }
    const revokedApi = await page
      .context()
      .request.get(`${fixture.origin}/api/monitoring/overview`);
    expect(revokedApi.status()).toBe(401);
    const revokedPage = await page.context().request.get(`${fixture.origin}/services`, {
      maxRedirects: 0,
    });
    expect(revokedPage.status()).toBe(307);
    expect(new URL(revokedPage.headers().location ?? "/", fixture.origin).pathname).toBe("/login");
  });

  test.describe("mobile staging", () => {
    test.use({
      hasTouch: true,
      isMobile: true,
      viewport: { height: 844, width: 390 },
    });

    test("keeps environment, session, service, and future-monitoring context visible", async ({
      page,
    }) => {
      const fixture = readFixture("staging");
      const runtimeErrors = captureRuntimeErrors(page);
      await signIn(page, fixture);

      await expect(page).toHaveTitle("STAGING · Esmii monitoring");
      await expect(page.locator("html")).not.toHaveAttribute("data-theme", "contract-test");
      await expect(page.locator(".sidebar")).toBeHidden();
      await expect(page.locator(".environment-rail")).toBeHidden();
      await expect(page.locator(".mobile-header")).toBeVisible();
      await expect(
        page.locator('.env-switch a[data-environment="staging"][data-current="true"]'),
      ).toHaveText("STAGING");
      await expect(page.locator('.env-switch a[data-environment="production"]')).toHaveAttribute(
        "href",
        fixture.peerOrigin,
      );
      await expect(page.locator(".mobile-operator")).toHaveText(fixture.email);
      await expect(page.locator(".mobile-freshness")).toContainText(/metrics|updated|fresh/iu);
      await expect(page.locator(".mobile-sign-out")).toBeVisible();

      const defaultTheme = await page.locator(".mobile-header").evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color };
      });
      expect(defaultTheme.background).toBe("rgb(255, 255, 255)");
      expect(defaultTheme.color).toBe("rgb(17, 20, 24)");
      await expectNoDocumentOverflow(page);

      await page.getByRole("link", { name: "Services", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Service health" })).toBeVisible();
      const firstService = page.locator(".service-row").first();
      await expect(firstService.getByText("CPU", { exact: true })).toBeVisible();
      await expect(firstService.getByText("Memory", { exact: true })).toBeVisible();
      await expect(firstService.getByText("Last restart", { exact: true })).toBeVisible();
      await expect(firstService.locator(".status-pill")).toContainText("healthy");
      await expectNoDocumentOverflow(page);

      await page.getByRole("link", { name: "Application" }).click();
      await expect(page.getByRole("heading", { name: "Application monitoring" })).toBeVisible();
      await expect(page.getByText("Not instrumented yet.")).toBeVisible();
      await expect(page.locator(".placeholder-card")).toHaveCount(3);
      await expectNoDocumentOverflow(page);
      await expect(page.locator("nextjs-portal")).toHaveCount(0);
      expect(runtimeErrors).toEqual([]);
    });
  });
});
