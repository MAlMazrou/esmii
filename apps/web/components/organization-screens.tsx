"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  apiPaths,
  createIdempotencyKey,
  patchJson,
  postJson,
  roleLabel,
  type OrganizationSummary,
} from "../lib/api";
import { useApiResource, useMutationState } from "../lib/hooks";
import { AppBoundary } from "./app-shell";
import {
  ApiErrorNotice,
  Button,
  EmptyPanel,
  Field,
  InlineNotice,
  LoadingState,
  Modal,
  RoleBadge,
} from "./ui";

function ScreenHeader({
  actions,
  description,
  eyebrow,
  title,
}: {
  actions?: ReactNode;
  description?: string;
  eyebrow?: string;
  title: string;
}) {
  return (
    <header className="screen-header">
      <div>
        {eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {actions === undefined ? null : <div className="screen-header__actions">{actions}</div>}
    </header>
  );
}

function OrganizationCreateForm({
  onCancel,
  onCreated,
}: {
  onCancel?: () => void;
  onCreated?: () => void;
}) {
  const mutation = useMutationState();
  const [displayName, setDisplayName] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = displayName.trim();
    if (name.length < 2) {
      setFieldError("Enter an organization name with at least 2 characters.");
      return;
    }

    mutation.begin();
    try {
      await postJson(
        apiPaths.organizations,
        { displayName: name },
        createIdempotencyKey("create-organization"),
      );
      mutation.clear();
      onCreated?.();
      window.location.assign("/app");
    } catch (error) {
      mutation.fail(error);
    }
  }

  return (
    <form className="form-stack" onSubmit={(event) => void createOrganization(event)}>
      <Field
        label="Organization name"
        error={fieldError}
        hint="A stable organization address will be created automatically."
      >
        <input
          autoComplete="organization"
          className="text-input"
          disabled={mutation.pending}
          maxLength={120}
          name="organizationName"
          value={displayName}
          aria-invalid={fieldError === null ? undefined : true}
          onChange={(event) => {
            setDisplayName(event.currentTarget.value);
            if (fieldError !== null) setFieldError(null);
          }}
        />
      </Field>
      <ApiErrorNotice error={mutation.error} />
      <div className="form-actions">
        {onCancel === undefined ? null : (
          <Button
            className="button--secondary"
            disabled={mutation.pending}
            type="button"
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
        <Button className="button--primary" disabled={mutation.pending} type="submit">
          {mutation.pending ? "Creating…" : "Create organization"}
        </Button>
      </div>
    </form>
  );
}

export function OverviewScreen() {
  return (
    <AppBoundary>
      {(viewer) => {
        const organization = viewer.activeOrganization;
        if (organization === null) return null;

        return (
          <div className="screen">
            <ScreenHeader
              eyebrow={organization.displayName}
              title="Overview"
              description="Your current organization and account access."
            />
            <section className="overview-grid" aria-label="Organization summary">
              <article className="summary-card summary-card--accent">
                <p className="summary-card__label">Organization</p>
                <h2>{organization.displayName}</h2>
                <p className="muted-copy">/{organization.locator}</p>
              </article>
              <article className="summary-card">
                <p className="summary-card__label">Current role</p>
                <div className="summary-card__role">
                  <RoleBadge role={organization.role} />
                  <span>{roleLabel(organization.role)} access</span>
                </div>
              </article>
              <article className="summary-card">
                <p className="summary-card__label">Organizations</p>
                <h2>{viewer.organizations.length}</h2>
                <Link href="/app/organizations">View and switch</Link>
              </article>
            </section>
            <section className="quiet-section">
              <h2>Account ready</h2>
              <p>
                Account and organization access are available. Product-specific work will be added
                only after its requirements are approved.
              </p>
            </section>
          </div>
        );
      }}
    </AppBoundary>
  );
}

export function OnboardingScreen() {
  return (
    <AppBoundary requireOrganization={false}>
      {(viewer) => (
        <div className="screen screen--narrow">
          <ScreenHeader
            eyebrow="Organization setup"
            title={
              viewer.activeOrganization === null
                ? "Create your first organization"
                : "Create another organization"
            }
            description="An organization is the workspace and access boundary for its members."
          />
          <section className="form-card">
            <OrganizationCreateForm />
          </section>
          {viewer.activeOrganization === null ? (
            <section className="quiet-section quiet-section--inline">
              <h2>Waiting for an invitation?</h2>
              <p>You can keep your account without creating an organization.</p>
              <Link href="/app/account">Continue to account settings</Link>
            </section>
          ) : null}
        </div>
      )}
    </AppBoundary>
  );
}

export function OrganizationsScreen() {
  const [createOpen, setCreateOpen] = useState(false);
  const mutation = useMutationState();

  async function openOrganization(organizationId: string) {
    mutation.begin();
    try {
      await postJson(
        apiPaths.switchOrganization,
        { organizationId },
        createIdempotencyKey("switch-organization"),
      );
      window.location.assign("/app");
    } catch (error) {
      mutation.fail(error);
    }
  }

  return (
    <AppBoundary requireOrganization={false}>
      {(viewer) => (
        <div className="screen">
          <ScreenHeader
            title="Organizations"
            description="Create organizations and choose the active workspace for this session."
            actions={
              <Button className="button--primary" type="button" onClick={() => setCreateOpen(true)}>
                Create organization
              </Button>
            }
          />
          <ApiErrorNotice error={mutation.error} />
          {viewer.organizations.length === 0 ? (
            <EmptyPanel title="No organizations yet">
              <p>Create one now, or return later after receiving an invitation.</p>
              <Button className="button--primary" type="button" onClick={() => setCreateOpen(true)}>
                Create organization
              </Button>
            </EmptyPanel>
          ) : (
            <ul className="organization-list" aria-label="Your organizations">
              {viewer.organizations.map((organization) => {
                const active = organization.id === viewer.activeOrganization?.id;
                return (
                  <li
                    key={organization.id}
                    className={active ? "organization-card is-active" : "organization-card"}
                  >
                    <div>
                      <div className="organization-card__title">
                        <h2>{organization.displayName}</h2>
                        {active ? (
                          <span className="status-badge status-badge--success">Active</span>
                        ) : null}
                      </div>
                      <p>/{organization.locator}</p>
                      <RoleBadge role={organization.role} />
                    </div>
                    {active ? (
                      <Link className="button button--secondary" href="/app">
                        Open overview
                      </Link>
                    ) : (
                      <Button
                        className="button--secondary"
                        disabled={mutation.pending}
                        type="button"
                        onClick={() => void openOrganization(organization.id)}
                      >
                        Switch and open
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <Modal
            open={createOpen}
            title="Create organization"
            description="You will become an owner of the new organization."
            onClose={() => setCreateOpen(false)}
          >
            <OrganizationCreateForm onCancel={() => setCreateOpen(false)} />
          </Modal>
        </div>
      )}
    </AppBoundary>
  );
}

function OrganizationSettingsDataScreen() {
  const organization = useApiResource<OrganizationSummary>(apiPaths.organization);
  const updateMutation = useMutationState();
  const deleteMutation = useMutationState();
  const [displayName, setDisplayName] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (organization.data !== null) setDisplayName(organization.data.displayName);
  }, [organization.data]);

  async function updateOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = displayName.trim();
    if (name.length < 2) return;

    updateMutation.begin();
    setSuccess(null);
    try {
      await patchJson(
        apiPaths.organization,
        { displayName: name },
        createIdempotencyKey("update-organization"),
      );
      updateMutation.clear();
      setSuccess("Organization settings updated.");
      organization.reload();
    } catch (error) {
      updateMutation.fail(error);
    }
  }

  async function deleteOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (organization.data === null || confirmation !== organization.data.displayName) return;

    deleteMutation.begin();
    try {
      await postJson(
        apiPaths.deleteOrganization,
        { confirmation },
        createIdempotencyKey("delete-organization"),
      );
      window.location.assign("/app/organizations");
    } catch (error) {
      deleteMutation.fail(error);
    }
  }

  return (
    <div className="screen screen--settings">
      <ScreenHeader
        title="Organization settings"
        description="Manage the current organization’s identity and access state."
      />
      {organization.status === "loading" ? (
        <LoadingState label="Loading organization settings" />
      ) : null}
      {organization.error === null ? null : (
        <section className="form-card">
          <ApiErrorNotice error={organization.error} />
          <Button type="button" onClick={organization.reload}>
            Try again
          </Button>
        </section>
      )}
      {organization.data === null ? null : (
        <>
          <section className="settings-section">
            <div className="settings-section__heading">
              <h2>Organization profile</h2>
              <p>The stable organization address cannot be changed here.</p>
            </div>
            <form className="form-stack" onSubmit={(event) => void updateOrganization(event)}>
              <Field label="Organization name">
                <input
                  className="text-input"
                  disabled={updateMutation.pending}
                  maxLength={120}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.currentTarget.value)}
                />
              </Field>
              <Field label="Organization address" hint="Stable locator">
                <input className="text-input" readOnly value={`/${organization.data.locator}`} />
              </Field>
              <ApiErrorNotice error={updateMutation.error} />
              {success === null ? null : <InlineNotice tone="success">{success}</InlineNotice>}
              <div className="form-actions">
                <Button
                  className="button--primary"
                  disabled={updateMutation.pending || displayName.trim().length < 2}
                  type="submit"
                >
                  {updateMutation.pending ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </section>

          <section className="settings-section">
            <div className="settings-section__heading">
              <h2>Owner controls</h2>
              <p>Owner access is managed from the verified member list.</p>
            </div>
            <Link className="button button--secondary" href="/app/members">
              Review members and owner access
            </Link>
            <InlineNotice tone="warning">
              Sensitive owner and deletion changes require recent authentication.
            </InlineNotice>
          </section>

          <section className="settings-section settings-section--danger">
            <div className="settings-section__heading">
              <h2>Delete organization</h2>
              <p>
                This immediately revokes normal access and pending invitations. Permanent erasure is
                not part of this action.
              </p>
            </div>
            <Button className="button--danger" type="button" onClick={() => setDeleteOpen(true)}>
              Delete organization
            </Button>
          </section>

          <Modal
            open={deleteOpen}
            title={`Delete ${organization.data.displayName}`}
            description="Normal access will be revoked immediately. This does not physically purge stored history."
            onClose={() => {
              if (!deleteMutation.pending) {
                setDeleteOpen(false);
                setConfirmation("");
              }
            }}
          >
            <form className="form-stack" onSubmit={(event) => void deleteOrganization(event)}>
              <Field label={`Type “${organization.data.displayName}” to confirm`}>
                <input
                  autoComplete="off"
                  className="text-input"
                  disabled={deleteMutation.pending}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.currentTarget.value)}
                />
              </Field>
              <ApiErrorNotice error={deleteMutation.error} />
              {deleteMutation.error?.code === "RECENT_AUTH_REQUIRED" ? (
                <Link href="/sign-in">Re-authenticate to continue</Link>
              ) : null}
              <div className="form-actions">
                <Button
                  className="button--secondary"
                  disabled={deleteMutation.pending}
                  type="button"
                  onClick={() => setDeleteOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  className="button--danger"
                  disabled={
                    deleteMutation.pending || confirmation !== organization.data.displayName
                  }
                  type="submit"
                >
                  {deleteMutation.pending ? "Deleting…" : "Delete organization"}
                </Button>
              </div>
            </form>
          </Modal>
        </>
      )}
    </div>
  );
}

export function OrganizationSettingsScreen() {
  return (
    <AppBoundary allowedRoles={["owner"]}>{() => <OrganizationSettingsDataScreen />}</AppBoundary>
  );
}
