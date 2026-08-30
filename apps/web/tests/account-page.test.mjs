import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const configSource = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
const signInSource = await readFile(
  new URL("../components/auth-screens.tsx", import.meta.url),
  "utf8",
);
const shellSource = await readFile(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
const settingsSource = await readFile(
  new URL("../components/organization-screens.tsx", import.meta.url),
  "utf8",
);
const apiSource = await readFile(new URL("../lib/api.ts", import.meta.url), "utf8");
const realtimeSource = await readFile(new URL("../lib/realtime.ts", import.meta.url), "utf8");
const stylesSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("routes the entry page from the server-backed viewer state", () => {
  assert.match(pageSource, /useApiResource<ViewerResponse>\(apiPaths\.viewer\)/u);
  assert.match(pageSource, /\/app\/onboarding/u);
  assert.match(pageSource, /router\.replace\("\/sign-in"\)/u);
});

test("keeps the Next.js runtime standalone and disk-cache free", () => {
  assert.match(configSource, /output:\s*"standalone"/u);
  assert.match(configSource, /unoptimized:\s*true/u);
});

test("keeps passwordless sign-in neutral and provider availability server-driven", () => {
  assert.match(signInSource, /Enter your email address/u);
  assert.match(signInSource, /If the address can sign in/u);
  assert.match(signInSource, /provider\.enabled/u);
  assert.doesNotMatch(signInSource, /type="password"|Forgot password|work email|>Help</iu);
});

test("keeps organization capabilities exact and product-neutral", () => {
  assert.match(shellSource, /label: "Members", roles: \["owner", "editor"\]/u);
  assert.match(shellSource, /label: "Invitations", roles: \["owner", "editor"\]/u);
  assert.match(shellSource, /label: "Organization settings", roles: \["owner"\]/u);
  assert.doesNotMatch(shellSource, /billing|subscription|project|customer|admin dashboard/iu);
});

test("describes organization deletion as access-revoking soft deletion", () => {
  assert.match(settingsSource, /immediately revokes normal access and pending invitations/u);
  assert.match(settingsSource, /Permanent\s+erasure is\s+not part of this action/u);
  assert.doesNotMatch(settingsSource, /permanently delete|physical purge/u);
});

test("centralizes same-origin API paths and validates social redirects", () => {
  assert.match(apiSource, /credentials: "same-origin"/u);
  assert.match(apiSource, /\/api\/auth\/magic-link\/request/u);
  assert.match(apiSource, /\/api\/organizations\/switch/u);
  assert.match(apiSource, /providerAuthorizationOrigins/u);
  assert.match(apiSource, /UNTRUSTED_REDIRECT/u);
});

test("keeps realtime organization scope server-selected", () => {
  assert.match(realtimeSource, /withCredentials: true/u);
  assert.match(realtimeSource, /socket\.on\("connect", handleConnect\)/u);
  assert.match(realtimeSource, /socket\.on\("organization:invalidate", handleInvalidation\)/u);
  assert.match(realtimeSource, /socket\.on\("organization:access-revoked", handleAccessRevoked\)/u);
  assert.doesNotMatch(realtimeSource, /socket\.emit|organizationId/u);
  assert.match(shellSource, /viewerResource\.status === "loading" && viewer === null/u);
});

test("includes responsive and reduced-motion behavior", () => {
  assert.match(stylesSource, /@media \(max-width: 56rem\)/u);
  assert.match(stylesSource, /@media \(max-width: 40rem\)/u);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(stylesSource, /\.skip-link/u);
});

test("defines every Prompt 03 web route", async () => {
  const routeFiles = [
    "../app/sign-in/page.tsx",
    "../app/sign-in/check-email/page.tsx",
    "../app/sign-in/result/page.tsx",
    "../app/invitation/page.tsx",
    "../app/app/page.tsx",
    "../app/app/onboarding/page.tsx",
    "../app/app/organizations/page.tsx",
    "../app/app/members/page.tsx",
    "../app/app/invitations/page.tsx",
    "../app/app/organization-settings/page.tsx",
    "../app/app/account/page.tsx",
    "../app/app/account/sessions/page.tsx",
    "../app/app/forbidden/page.tsx",
  ];

  await Promise.all(routeFiles.map((path) => access(new URL(path, import.meta.url))));
});
