"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

import {
  apiPaths,
  createIdempotencyKey,
  deleteJson,
  patchJson,
  postJson,
  providerLabel,
  startProviderLink,
  type AccountProviderSummary,
  type AccountProvidersResponse,
  type SessionSummary,
  type SessionsResponse,
  type ViewerResponse,
} from "../lib/api";
import { formatDateUtc } from "../lib/format";
import { useApiResource, useMutationState } from "../lib/hooks";
import { AppBoundary } from "./app-shell";
import {
  ApiErrorNotice,
  Avatar,
  Button,
  EmptyPanel,
  Field,
  InlineNotice,
  LoadingState,
  Modal,
  StatusBadge,
} from "./ui";

function AccountHeader({ description, title }: { description: string; title: string }) {
  return (
    <header className="screen-header">
      <div>
        <p className="eyebrow">Account</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
    </header>
  );
}

function ProviderRow({
  onDisconnect,
  onLink,
  pending,
  provider,
}: {
  onDisconnect: (provider: AccountProviderSummary) => void;
  onLink: (provider: AccountProviderSummary) => void;
  pending: boolean;
  provider: AccountProviderSummary;
}) {
  return (
    <li className="provider-row">
      <div>
        <strong>{provider.label || providerLabel(provider.id)}</strong>
        <span>{provider.connected ? "Connected" : "Not connected"}</span>
        {provider.connected && !provider.canDisconnect ? (
          <small>This is your final usable sign-in method.</small>
        ) : null}
      </div>
      {provider.connected ? (
        <Button
          className="button--secondary"
          disabled={pending || !provider.canDisconnect}
          type="button"
          onClick={() => onDisconnect(provider)}
        >
          Disconnect
        </Button>
      ) : (
        <Button
          className="button--secondary"
          disabled={pending}
          type="button"
          onClick={() => onLink(provider)}
        >
          Connect
        </Button>
      )}
    </li>
  );
}

function AccountDataScreen({
  onViewerChanged,
  viewer,
}: {
  onViewerChanged: () => void;
  viewer: ViewerResponse;
}) {
  const providers = useApiResource<AccountProvidersResponse>(apiPaths.accountProviders);
  const profileMutation = useMutationState();
  const providerMutation = useMutationState();
  const [displayName, setDisplayName] = useState(viewer.user.displayName);
  const [disconnectProvider, setDisconnectProvider] = useState<AccountProviderSummary | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(viewer.user.displayName);
  }, [viewer.user.displayName]);

  async function updateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = displayName.trim();
    if (name.length < 2) return;
    profileMutation.begin();
    setSuccess(null);
    try {
      await patchJson(
        apiPaths.accountProfile,
        { displayName: name },
        createIdempotencyKey("update-profile"),
      );
      profileMutation.clear();
      setSuccess("Account profile updated.");
      onViewerChanged();
    } catch (error) {
      profileMutation.fail(error);
    }
  }

  async function linkProvider(provider: AccountProviderSummary) {
    providerMutation.begin();
    setSuccess(null);
    try {
      await startProviderLink(provider.id);
    } catch (error) {
      providerMutation.fail(error);
    }
  }

  async function disconnect() {
    if (disconnectProvider === null) return;
    providerMutation.begin();
    setSuccess(null);
    try {
      await deleteJson(
        apiPaths.provider(disconnectProvider.id),
        undefined,
        createIdempotencyKey("disconnect-provider"),
      );
      providerMutation.clear();
      setDisconnectProvider(null);
      setSuccess("Sign-in method disconnected.");
      providers.reload();
    } catch (error) {
      providerMutation.fail(error);
    }
  }

  async function logout() {
    providerMutation.begin();
    try {
      await postJson(apiPaths.logout);
      window.location.replace("/sign-in");
    } catch (error) {
      providerMutation.fail(error);
    }
  }

  const configuredProviders = providers.data?.items.filter((provider) => provider.configured) ?? [];

  return (
    <div className="screen screen--settings">
      <AccountHeader
        title="Account settings"
        description="Manage your profile, sign-in methods, and sessions."
      />
      {success === null ? null : <InlineNotice tone="success">{success}</InlineNotice>}

      <section className="settings-section">
        <div className="account-profile-heading">
          <Avatar displayName={viewer.user.displayName} email={viewer.user.email} />
          <span>
            <strong>{viewer.user.displayName}</strong>
            <small>{viewer.user.email}</small>
          </span>
        </div>
        <form className="form-stack" onSubmit={(event) => void updateProfile(event)}>
          <Field label="Display name">
            <input
              autoComplete="name"
              className="text-input"
              disabled={profileMutation.pending}
              maxLength={120}
              value={displayName}
              onChange={(event) => setDisplayName(event.currentTarget.value)}
            />
          </Field>
          <Field
            label="Email address"
            hint="Changing your primary email is not available in this account."
          >
            <input className="text-input" readOnly value={viewer.user.email} />
          </Field>
          <div className="verified-line">
            <StatusBadge
              label={viewer.user.emailVerified ? "Verified email" : "Email not verified"}
              tone={viewer.user.emailVerified ? "success" : "warning"}
            />
          </div>
          <ApiErrorNotice error={profileMutation.error} />
          <div className="form-actions">
            <Button
              className="button--primary"
              disabled={profileMutation.pending || displayName.trim().length < 2}
              type="submit"
            >
              {profileMutation.pending ? "Saving…" : "Save profile"}
            </Button>
          </div>
        </form>
      </section>

      <section className="settings-section">
        <div className="settings-section__heading">
          <h2>Sign-in methods</h2>
          <p>Only configured methods appear. A final usable method cannot be disconnected.</p>
        </div>
        {providers.status === "loading" ? <LoadingState label="Loading sign-in methods" /> : null}
        {providers.error === null ? null : (
          <>
            <ApiErrorNotice error={providers.error} />
            <Button type="button" onClick={providers.reload}>
              Try again
            </Button>
          </>
        )}
        {providers.data !== null && configuredProviders.length === 0 ? (
          <p className="muted-copy">No additional provider is configured.</p>
        ) : null}
        {configuredProviders.length === 0 ? null : (
          <ul className="provider-account-list">
            {configuredProviders.map((provider) => (
              <ProviderRow
                key={provider.id}
                pending={providerMutation.pending}
                provider={provider}
                onDisconnect={setDisconnectProvider}
                onLink={(selectedProvider) => void linkProvider(selectedProvider)}
              />
            ))}
          </ul>
        )}
        <ApiErrorNotice error={providerMutation.error} />
        {providerMutation.error?.code === "RECENT_AUTH_REQUIRED" ? (
          <Link href="/sign-in">Re-authenticate to continue</Link>
        ) : null}
      </section>

      <section className="settings-section settings-section--row">
        <div className="settings-section__heading">
          <h2>Active sessions</h2>
          <p>Review devices signed in to this account and revoke access.</p>
        </div>
        <Link className="button button--secondary" href="/app/account/sessions">
          Review sessions
        </Link>
      </section>

      <section className="settings-section settings-section--row">
        <div className="settings-section__heading">
          <h2>Sign out</h2>
          <p>Invalidate the current session on this device.</p>
        </div>
        <Button
          className="button--secondary"
          disabled={providerMutation.pending}
          type="button"
          onClick={() => void logout()}
        >
          Sign out
        </Button>
      </section>

      <Modal
        open={disconnectProvider !== null}
        title={`Disconnect ${disconnectProvider?.label ?? "sign-in method"}`}
        description="You may be asked to re-authenticate. Your final usable sign-in method cannot be removed."
        onClose={() => {
          if (!providerMutation.pending) {
            providerMutation.clear();
            setDisconnectProvider(null);
          }
        }}
      >
        <ApiErrorNotice error={providerMutation.error} />
        <div className="form-actions">
          <Button
            className="button--secondary"
            disabled={providerMutation.pending}
            type="button"
            onClick={() => setDisconnectProvider(null)}
          >
            Cancel
          </Button>
          <Button
            className="button--danger"
            disabled={providerMutation.pending}
            type="button"
            onClick={() => void disconnect()}
          >
            {providerMutation.pending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export function AccountScreen() {
  return (
    <AppBoundary requireOrganization={false}>
      {(viewer, reloadViewer) => (
        <AccountDataScreen viewer={viewer} onViewerChanged={reloadViewer} />
      )}
    </AppBoundary>
  );
}

function SessionRow({
  onRevoke,
  pending,
  session,
}: {
  onRevoke: (session: SessionSummary) => void;
  pending: boolean;
  session: SessionSummary;
}) {
  return (
    <li className="session-row">
      <div>
        <div className="session-row__title">
          <strong>{session.clientLabel}</strong>
          {session.current ? <StatusBadge label="Current session" tone="success" /> : null}
        </div>
        <span>
          Last active <time dateTime={session.lastSeenAt}>{formatDateUtc(session.lastSeenAt)}</time>
        </span>
        <small>
          Created <time dateTime={session.createdAt}>{formatDateUtc(session.createdAt)}</time>
        </small>
      </div>
      {session.current ? (
        <span className="muted-copy">Use Sign out to end this session</span>
      ) : (
        <Button
          className="button--secondary"
          disabled={pending}
          type="button"
          onClick={() => onRevoke(session)}
        >
          Revoke
        </Button>
      )}
    </li>
  );
}

function SessionsDataScreen() {
  const sessions = useApiResource<SessionsResponse>(apiPaths.sessions);
  const mutation = useMutationState();
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const [revokeOthersOpen, setRevokeOthersOpen] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  async function revokeSession() {
    if (selectedSession === null) return;
    mutation.begin();
    setSuccess(null);
    try {
      await deleteJson(
        apiPaths.session(selectedSession.id),
        undefined,
        createIdempotencyKey("revoke-session"),
      );
      mutation.clear();
      setSelectedSession(null);
      setSuccess("Session revoked.");
      sessions.reload();
    } catch (error) {
      mutation.fail(error);
    }
  }

  async function revokeOtherSessions() {
    mutation.begin();
    setSuccess(null);
    try {
      await postJson(
        apiPaths.revokeOtherSessions,
        undefined,
        createIdempotencyKey("revoke-other-sessions"),
      );
      mutation.clear();
      setRevokeOthersOpen(false);
      setSuccess("Other sessions revoked.");
      sessions.reload();
    } catch (error) {
      mutation.fail(error);
    }
  }

  const otherSessions = sessions.data?.items.filter((session) => !session.current).length ?? 0;

  return (
    <div className="screen screen--settings">
      <AccountHeader
        title="Active sessions"
        description="Review and revoke access without exposing session tokens."
      />
      <div className="back-link-row">
        <Link href="/app/account">Back to account settings</Link>
      </div>
      {success === null ? null : <InlineNotice tone="success">{success}</InlineNotice>}
      <ApiErrorNotice error={mutation.error} />
      {mutation.error?.code === "RECENT_AUTH_REQUIRED" ? (
        <Link href="/sign-in">Re-authenticate to continue</Link>
      ) : null}
      {sessions.status === "loading" ? <LoadingState label="Loading active sessions" /> : null}
      {sessions.error === null ? null : (
        <section className="form-card">
          <ApiErrorNotice error={sessions.error} />
          <Button type="button" onClick={sessions.reload}>
            Try again
          </Button>
        </section>
      )}
      {sessions.data !== null && sessions.data.items.length === 0 ? (
        <EmptyPanel title="No sessions found">
          <p>Refresh the page after signing in again.</p>
        </EmptyPanel>
      ) : null}
      {sessions.data === null || sessions.data.items.length === 0 ? null : (
        <section className="settings-section">
          <ul className="session-list">
            {sessions.data.items.map((session) => (
              <SessionRow
                key={session.id}
                pending={mutation.pending}
                session={session}
                onRevoke={setSelectedSession}
              />
            ))}
          </ul>
          <div className="form-actions">
            <Button
              className="button--danger"
              disabled={mutation.pending || otherSessions === 0}
              type="button"
              onClick={() => setRevokeOthersOpen(true)}
            >
              Revoke all other sessions
            </Button>
          </div>
        </section>
      )}

      <Modal
        open={selectedSession !== null}
        title="Revoke this session?"
        description={selectedSession?.clientLabel}
        onClose={() => {
          if (!mutation.pending) {
            mutation.clear();
            setSelectedSession(null);
          }
        }}
      >
        <p>The selected device will need to sign in again.</p>
        <ApiErrorNotice error={mutation.error} />
        <div className="form-actions">
          <Button
            className="button--secondary"
            disabled={mutation.pending}
            type="button"
            onClick={() => setSelectedSession(null)}
          >
            Cancel
          </Button>
          <Button
            className="button--danger"
            disabled={mutation.pending}
            type="button"
            onClick={() => void revokeSession()}
          >
            {mutation.pending ? "Revoking…" : "Revoke session"}
          </Button>
        </div>
      </Modal>

      <Modal
        open={revokeOthersOpen}
        title="Revoke all other sessions?"
        description="Your current session will remain active."
        onClose={() => {
          if (!mutation.pending) {
            mutation.clear();
            setRevokeOthersOpen(false);
          }
        }}
      >
        <ApiErrorNotice error={mutation.error} />
        <div className="form-actions">
          <Button
            className="button--secondary"
            disabled={mutation.pending}
            type="button"
            onClick={() => setRevokeOthersOpen(false)}
          >
            Cancel
          </Button>
          <Button
            className="button--danger"
            disabled={mutation.pending}
            type="button"
            onClick={() => void revokeOtherSessions()}
          >
            {mutation.pending ? "Revoking…" : "Revoke other sessions"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export function SessionsScreen() {
  return <AppBoundary requireOrganization={false}>{() => <SessionsDataScreen />}</AppBoundary>;
}
