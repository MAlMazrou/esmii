import { describe, expect, it } from "vitest";

import {
  isOrganizationRole,
  organizationCapabilities,
  roleHasCapability,
} from "../src/authorization.js";

describe("organization role matrix", () => {
  it("recognizes only the three approved roles", () => {
    expect(isOrganizationRole("owner")).toBe(true);
    expect(isOrganizationRole("editor")).toBe(true);
    expect(isOrganizationRole("member")).toBe(true);
    expect(isOrganizationRole("admin")).toBe(false);
  });

  it("keeps owner-only and owner/editor capabilities explicit", () => {
    expect(roleHasCapability("owner", "organization:delete")).toBe(true);
    expect(roleHasCapability("editor", "organization:delete")).toBe(false);
    expect(roleHasCapability("editor", "invitations:manage")).toBe(true);
    expect(roleHasCapability("member", "invitations:manage")).toBe(false);

    for (const capability of organizationCapabilities) {
      expect(roleHasCapability("owner", capability)).toBe(true);
    }
  });
});
