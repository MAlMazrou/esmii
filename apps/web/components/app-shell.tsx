"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import {
  ApiRequestError,
  apiPaths,
  createIdempotencyKey,
  postJson,
  type OrganizationRole,
  type ViewerResponse,
} from "../lib/api";
import { useApiResource } from "../lib/hooks";
import { useOrganizationRealtime } from "../lib/realtime";
import { ApiErrorNotice, Avatar, Brand, Button, LoadingState, PageState } from "./ui";

interface NavigationItem {
  href: string;
  label: string;
  roles: readonly OrganizationRole[];
}

const organizationNavigation: readonly NavigationItem[] = [
  { href: "/app", label: "Overview", roles: ["owner", "editor", "member"] },
  { href: "/app/members", label: "Members", roles: ["owner", "editor"] },
  { href: "/app/invitations", label: "Invitations", roles: ["owner", "editor"] },
  { href: "/app/organization-settings", label: "Organization settings", roles: ["owner"] },
];

function hasRole(role: OrganizationRole, allowedRoles: readonly OrganizationRole[]): boolean {
  return allowedRoles.includes(role);
}

function AppNavigation({ viewer }: { viewer: ViewerResponse }) {
  const pathname = usePathname();
  const role = viewer.activeOrganization?.role;
  if (role === undefined) return null;

  const items = organizationNavigation.filter((item) => hasRole(role, item.roles));
  return (
    <nav className="organization-nav" aria-label="Organization">
      {items.map((item) => (
        <Link
          key={item.href}
          className={
            pathname === item.href ? "organization-nav__link is-current" : "organization-nav__link"
          }
          href={item.href}
          aria-current={pathname === item.href ? "page" : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

function MobileSectionNavigation({ viewer }: { viewer: ViewerResponse }) {
  const pathname = usePathname();
  const role = viewer.activeOrganization?.role;
  if (role === undefined || role === "member") return null;

  const items = organizationNavigation.filter(
    (item) => item.href !== "/app" && hasRole(role, item.roles),
  );
  return (
    <nav className="mobile-section-nav" aria-label="Organization sections">
      {items.map((item) => (
        <Link
          key={item.href}
          className={
            pathname === item.href
              ? "mobile-section-nav__link is-current"
              : "mobile-section-nav__link"
          }
          href={item.href}
          aria-current={pathname === item.href ? "page" : undefined}
        >
          {item.label === "Organization settings" ? "Settings" : item.label}
        </Link>
      ))}
    </nav>
  );
}

export function AppShell({ children, viewer }: { children: ReactNode; viewer: ViewerResponse }) {
  const [pendingOrganization, setPendingOrganization] = useState(false);
  const [shellError, setShellError] = useState<ApiRequestError | null>(null);
  useOrganizationRealtime(viewer.activeOrganization !== null);

  async function switchOrganization(organizationId: string) {
    if (organizationId.length === 0 || organizationId === viewer.activeOrganization?.id) return;
    setPendingOrganization(true);
    setShellError(null);
    try {
      await postJson(
        apiPaths.switchOrganization,
        { organizationId },
        createIdempotencyKey("switch-organization"),
      );
      window.location.assign("/app");
    } catch (error) {
      setPendingOrganization(false);
      setShellError(
        error instanceof ApiRequestError
          ? error
          : new ApiRequestError(
              0,
              "NETWORK_ERROR",
              "The organization could not be switched.",
              null,
            ),
      );
    }
  }

  async function logout() {
    setShellError(null);
    try {
      await postJson(apiPaths.logout);
      window.location.replace("/sign-in");
    } catch (error) {
      setShellError(
        error instanceof ApiRequestError
          ? error
          : new ApiRequestError(0, "NETWORK_ERROR", "Sign out could not be completed.", null),
      );
    }
  }

  const organizationSelector = (
    <label className="organization-selector">
      <span className="sr-only">Active organization</span>
      <select
        value={viewer.activeOrganization?.id ?? ""}
        disabled={pendingOrganization}
        onChange={(event) => void switchOrganization(event.currentTarget.value)}
      >
        <option value="" disabled>
          Choose organization
        </option>
        {viewer.organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.displayName}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <aside className="desktop-sidebar">
        <Link className="brand-link" href="/app" aria-label="Esmii overview">
          <Brand />
        </Link>
        <div className="desktop-sidebar__organization">
          <span className="sidebar-label">Organization</span>
          {organizationSelector}
          <Link className="manage-organizations-link" href="/app/organizations">
            Manage organizations
          </Link>
        </div>
        <AppNavigation viewer={viewer} />
        <div className="desktop-sidebar__account">
          <Link className="account-summary" href="/app/account">
            <Avatar displayName={viewer.user.displayName} email={viewer.user.email} />
            <span>
              <strong>{viewer.user.displayName}</strong>
              <small>{viewer.user.email}</small>
            </span>
          </Link>
          <Link className="sidebar-account-link" href="/app/account">
            Account settings
          </Link>
          <Button
            className="button--text sidebar-logout"
            type="button"
            onClick={() => void logout()}
          >
            Sign out
          </Button>
        </div>
      </aside>

      <header className="mobile-app-bar">
        <Link className="brand-link" href="/app" aria-label="Esmii overview">
          <Brand />
        </Link>
        {organizationSelector}
        <Link className="mobile-account-link" href="/app/account" aria-label="Account settings">
          <Avatar displayName={viewer.user.displayName} email={viewer.user.email} />
        </Link>
      </header>

      <div className="app-shell__body">
        {shellError === null ? null : (
          <div className="app-shell__notice">
            <ApiErrorNotice error={shellError} />
          </div>
        )}
        <MobileSectionNavigation viewer={viewer} />
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

export function AppBoundary({
  allowedRoles,
  children,
  requireOrganization = true,
}: {
  allowedRoles?: readonly OrganizationRole[];
  children: (viewer: ViewerResponse, reloadViewer: () => void) => ReactNode;
  requireOrganization?: boolean;
}) {
  const router = useRouter();
  const viewerResource = useApiResource<ViewerResponse>(apiPaths.viewer);
  const viewer = viewerResource.data;

  useEffect(() => {
    if (viewerResource.error?.status === 401) router.replace("/sign-in");
  }, [router, viewerResource.error]);

  useEffect(() => {
    if (
      viewerResource.status === "ready" &&
      viewer !== null &&
      requireOrganization &&
      viewer.activeOrganization === null
    ) {
      router.replace("/app/onboarding");
    }
  }, [requireOrganization, router, viewer, viewerResource.status]);

  if (
    (viewerResource.status === "loading" && viewer === null) ||
    viewerResource.error?.status === 401
  ) {
    return (
      <div className="route-loading-shell">
        <Brand />
        <LoadingState label="Loading your account" />
      </div>
    );
  }

  if (viewerResource.error !== null || viewer === null) {
    return (
      <PageState
        title="We could not load this page"
        description="The service did not return your account details. Try again."
        tone="danger"
        action={
          <Button type="button" onClick={viewerResource.reload}>
            Try again
          </Button>
        }
      />
    );
  }

  if (requireOrganization && viewer.activeOrganization === null) {
    return (
      <div className="route-loading-shell">
        <Brand />
        <LoadingState label="Opening organization setup" />
      </div>
    );
  }

  const role = viewer.activeOrganization?.role;
  if (allowedRoles !== undefined && (role === undefined || !hasRole(role, allowedRoles))) {
    return (
      <AppShell viewer={viewer}>
        <PageState
          title="You do not have access"
          description="Your organization role does not allow this action."
          action={<Link href="/app">Return to overview</Link>}
        />
      </AppShell>
    );
  }

  return <AppShell viewer={viewer}>{children(viewer, viewerResource.reload)}</AppShell>;
}
