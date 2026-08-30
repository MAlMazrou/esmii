"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  apiPaths,
  createIdempotencyKey,
  deleteJson,
  patchJson,
  postJson,
  type InvitationStatus,
  type InvitationSummary,
  type InvitationsResponse,
  type MemberSummary,
  type MembersResponse,
  type OrganizationRole,
  type ViewerResponse,
} from "../lib/api";
import { formatDateUtc, invitationExpiryLabel } from "../lib/format";
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
  RoleBadge,
  StatusBadge,
} from "./ui";

type MemberAction = "menu" | "role" | "remove" | "grant-owner";

function statusTone(status: InvitationStatus): "neutral" | "success" | "warning" {
  if (status === "accepted") return "success";
  if (status === "pending") return "warning";
  return "neutral";
}

function ScreenTitle({
  action,
  description,
  title,
}: {
  action?: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <header className="screen-header screen-header--members">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action === undefined ? null : <div className="screen-header__actions">{action}</div>}
    </header>
  );
}

function MemberCollection({
  actorRole,
  members,
  onManage,
}: {
  actorRole: OrganizationRole;
  members: MembersResponse;
  onManage: (member: MemberSummary) => void;
}) {
  if (members.items.length === 0) {
    return (
      <EmptyPanel title="No members found">
        <p>Invite a verified person to join this organization.</p>
      </EmptyPanel>
    );
  }

  return (
    <div className="member-collection">
      <div className="member-collection__head" aria-hidden="true">
        <span>Member</span>
        <span>Role</span>
        <span>Status</span>
        <span>Joined</span>
        <span>Actions</span>
      </div>
      <ul aria-label="Organization members">
        {members.items.map((member) => {
          const manageable = actorRole === "owner" && member.role !== "owner";
          return (
            <li key={member.id} className="member-row">
              <div className="member-identity">
                <Avatar displayName={member.displayName} email={member.email} />
                <span>
                  <strong>
                    {member.displayName}
                    {member.isCurrentUser ? <small className="self-label">You</small> : null}
                  </strong>
                  <small>{member.email}</small>
                </span>
              </div>
              <div className="member-row__field" data-label="Role">
                <RoleBadge role={member.role} />
              </div>
              <div className="member-row__field" data-label="Status">
                <StatusBadge
                  label={member.emailVerified ? "Active" : "Unverified"}
                  tone={member.emailVerified ? "success" : "warning"}
                />
              </div>
              <div className="member-row__field" data-label="Joined">
                <time dateTime={member.joinedAt}>{formatDateUtc(member.joinedAt)}</time>
              </div>
              <div className="member-row__actions">
                {manageable ? (
                  <Button
                    className="button--compact button--secondary"
                    type="button"
                    onClick={() => onManage(member)}
                  >
                    Manage
                  </Button>
                ) : (
                  <span className="muted-copy">—</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="collection-footer">
        Showing {members.items.length} of {members.total} members
      </p>
    </div>
  );
}

function InviteMemberModal({
  onClose,
  onCreated,
  open,
}: {
  onClose: () => void;
  onCreated: () => void;
  open: boolean;
}) {
  const mutation = useMutationState();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "member">("member");
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (!/^\S+@\S+\.\S+$/u.test(normalizedEmail)) {
      setFieldError("Enter a complete email address.");
      return;
    }

    mutation.begin();
    try {
      await postJson(
        apiPaths.invitations,
        { email: normalizedEmail, role },
        createIdempotencyKey("create-invitation"),
      );
      mutation.clear();
      setEmail("");
      setRole("member");
      onCreated();
      onClose();
    } catch (error) {
      mutation.fail(error);
    }
  }

  return (
    <Modal
      open={open}
      title="Invite member"
      description="Invitations expire after seven days and can be used only by the matching verified email address."
      onClose={() => {
        if (!mutation.pending) onClose();
      }}
    >
      <form className="form-stack" onSubmit={(event) => void invite(event)}>
        <Field label="Email address" error={fieldError}>
          <input
            autoComplete="email"
            className="text-input"
            disabled={mutation.pending}
            inputMode="email"
            type="email"
            value={email}
            aria-invalid={fieldError === null ? undefined : true}
            onChange={(event) => {
              setEmail(event.currentTarget.value);
              if (fieldError !== null) setFieldError(null);
            }}
          />
        </Field>
        <Field label="Organization role">
          <select
            className="select-input"
            disabled={mutation.pending}
            value={role}
            onChange={(event) => setRole(event.currentTarget.value as "editor" | "member")}
          >
            <option value="member">Member</option>
            <option value="editor">Editor</option>
          </select>
        </Field>
        <ApiErrorNotice error={mutation.error} />
        <div className="form-actions">
          <Button
            className="button--secondary"
            disabled={mutation.pending}
            type="button"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button className="button--primary" disabled={mutation.pending} type="submit">
            {mutation.pending ? "Sending…" : "Send invitation"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function MemberActionsModal({
  member,
  onClose,
  onUpdated,
}: {
  member: MemberSummary | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const mutation = useMutationState();
  const [action, setAction] = useState<MemberAction>("menu");
  const [role, setRole] = useState<"editor" | "member">(
    member?.role === "editor" ? "editor" : "member",
  );

  useEffect(() => {
    setAction("menu");
    setRole(member?.role === "editor" ? "editor" : "member");
  }, [member]);

  function close() {
    if (mutation.pending) return;
    setAction("menu");
    mutation.clear();
    onClose();
  }

  async function updateRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (member === null) return;
    mutation.begin();
    try {
      await patchJson(
        apiPaths.member(member.id),
        { role },
        createIdempotencyKey("change-member-role"),
      );
      mutation.clear();
      onUpdated();
      close();
    } catch (error) {
      mutation.fail(error);
    }
  }

  async function removeMember() {
    if (member === null) return;
    mutation.begin();
    try {
      await deleteJson(
        apiPaths.member(member.id),
        undefined,
        createIdempotencyKey("remove-member"),
      );
      mutation.clear();
      onUpdated();
      close();
    } catch (error) {
      mutation.fail(error);
    }
  }

  async function grantOwnerAccess() {
    if (member === null) return;
    mutation.begin();
    try {
      await postJson(
        apiPaths.grantOwner(member.id),
        undefined,
        createIdempotencyKey("grant-owner"),
      );
      mutation.clear();
      onUpdated();
      close();
    } catch (error) {
      mutation.fail(error);
    }
  }

  const title = member?.displayName ?? "Member actions";
  return (
    <Modal open={member !== null} title={title} description={member?.email} onClose={close}>
      {action === "menu" ? (
        <div className="action-list">
          {member?.role === "owner" ? null : (
            <>
              <Button
                className="action-list__button"
                type="button"
                onClick={() => setAction("role")}
              >
                <strong>Change role</strong>
                <span>Set this member’s editor or member access.</span>
              </Button>
              <Button
                className="action-list__button"
                type="button"
                onClick={() => setAction("remove")}
              >
                <strong>Remove member</strong>
                <span>Remove this person from the current organization.</span>
              </Button>
              {member?.emailVerified ? (
                <Button
                  className="action-list__button"
                  type="button"
                  onClick={() => setAction("grant-owner")}
                >
                  <strong>Grant owner access</strong>
                  <span>Add owner authority without removing your own access.</span>
                </Button>
              ) : null}
            </>
          )}
          <InlineNotice tone="warning">
            Sensitive owner changes require recent authentication.
          </InlineNotice>
        </div>
      ) : null}

      {action === "role" ? (
        <form className="form-stack" onSubmit={(event) => void updateRole(event)}>
          <Field label="Organization role">
            <select
              className="select-input"
              disabled={mutation.pending}
              value={role}
              onChange={(event) => setRole(event.currentTarget.value as "editor" | "member")}
            >
              <option value="member">Member</option>
              <option value="editor">Editor</option>
            </select>
          </Field>
          <ApiErrorNotice error={mutation.error} />
          <div className="form-actions">
            <Button
              className="button--secondary"
              disabled={mutation.pending}
              type="button"
              onClick={() => setAction("menu")}
            >
              Back
            </Button>
            <Button className="button--primary" disabled={mutation.pending} type="submit">
              {mutation.pending ? "Saving…" : "Save role"}
            </Button>
          </div>
        </form>
      ) : null}

      {action === "remove" ? (
        <div className="form-stack">
          <p>This immediately ends the member’s access to the current organization.</p>
          <ApiErrorNotice error={mutation.error} />
          <div className="form-actions">
            <Button
              className="button--secondary"
              disabled={mutation.pending}
              type="button"
              onClick={() => setAction("menu")}
            >
              Back
            </Button>
            <Button
              className="button--danger"
              disabled={mutation.pending}
              type="button"
              onClick={() => void removeMember()}
            >
              {mutation.pending ? "Removing…" : "Remove member"}
            </Button>
          </div>
        </div>
      ) : null}

      {action === "grant-owner" ? (
        <div className="form-stack">
          <p>Owner access controls membership, organization settings, and organization deletion.</p>
          <ApiErrorNotice error={mutation.error} />
          {mutation.error?.code === "RECENT_AUTH_REQUIRED" ? (
            <Link href="/sign-in">Re-authenticate to continue</Link>
          ) : null}
          <div className="form-actions">
            <Button
              className="button--secondary"
              disabled={mutation.pending}
              type="button"
              onClick={() => setAction("menu")}
            >
              Back
            </Button>
            <Button
              className="button--primary"
              disabled={mutation.pending}
              type="button"
              onClick={() => void grantOwnerAccess()}
            >
              {mutation.pending ? "Granting…" : "Grant owner access"}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function PendingInvitationRail({
  invitations,
  onAction,
  pendingAction,
}: {
  invitations: InvitationsResponse;
  onAction: (action: "resend" | "revoke", invitation: InvitationSummary) => void;
  pendingAction: string | null;
}) {
  const pendingInvitations = invitations.items
    .filter((invitation) => invitation.status === "pending")
    .slice(0, 3);
  return (
    <aside className="pending-rail" aria-labelledby="pending-invitations-title">
      <div className="pending-rail__heading">
        <h2 id="pending-invitations-title">Pending invitations</h2>
        <span className="count-badge">{invitations.pendingCount}</span>
      </div>
      <p>Invitations expire after seven days.</p>
      {pendingInvitations.length === 0 ? (
        <p className="muted-copy">No pending invitations.</p>
      ) : (
        <ul>
          {pendingInvitations.map((invitation) => (
            <li key={invitation.id}>
              <div className="pending-invitation__identity">
                <Avatar displayName={invitation.email} email={invitation.email} />
                <span>
                  <strong>{invitation.email}</strong>
                  <RoleBadge role={invitation.role} />
                  <small>{invitationExpiryLabel(invitation.expiresAt)}</small>
                </span>
              </div>
              <div className="inline-actions">
                <Button
                  className="button--text"
                  disabled={pendingAction !== null}
                  type="button"
                  onClick={() => onAction("resend", invitation)}
                >
                  Resend
                </Button>
                <Button
                  className="button--text button--text-danger"
                  disabled={pendingAction !== null}
                  type="button"
                  onClick={() => onAction("revoke", invitation)}
                >
                  Revoke
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Link href="/app/invitations">View all invitations</Link>
    </aside>
  );
}

function MembersDataScreen({ viewer }: { viewer: ViewerResponse }) {
  const members = useApiResource<MembersResponse>(apiPaths.members);
  const invitations = useApiResource<InvitationsResponse>(apiPaths.invitations);
  const invitationMutation = useMutationState();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [managedMember, setManagedMember] = useState<MemberSummary | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const organization = viewer.activeOrganization;
  if (organization === null) return null;

  async function invitationAction(action: "resend" | "revoke", invitation: InvitationSummary) {
    setPendingAction(`${action}:${invitation.id}`);
    setSuccess(null);
    invitationMutation.begin();
    try {
      await postJson(
        apiPaths.invitationAction(invitation.id, action),
        undefined,
        createIdempotencyKey(`${action}-invitation`),
      );
      invitationMutation.clear();
      setPendingAction(null);
      setSuccess(action === "resend" ? "Invitation resent." : "Invitation revoked.");
      invitations.reload();
    } catch (error) {
      setPendingAction(null);
      invitationMutation.fail(error);
    }
  }

  return (
    <div className="screen screen--wide">
      <ScreenTitle
        title="Members"
        description={
          members.data === null
            ? "People in this organization"
            : `${members.data.total} people in this organization`
        }
        action={
          <Button className="button--primary" type="button" onClick={() => setInviteOpen(true)}>
            Invite member
          </Button>
        }
      />

      <section className="member-stats" aria-label="Member summary">
        <div>
          <strong>{members.data?.total ?? "—"}</strong>
          <span>Members</span>
        </div>
        <div>
          <strong>{invitations.data?.pendingCount ?? "—"}</strong>
          <span>Pending invitations</span>
        </div>
        <div>
          <span>Current role</span>
          <RoleBadge role={organization.role} />
        </div>
      </section>

      <ApiErrorNotice error={invitationMutation.error} />
      {success === null ? null : <InlineNotice tone="success">{success}</InlineNotice>}

      <div className="members-layout">
        <section aria-label="Members">
          {members.status === "loading" ? <LoadingState label="Loading members" /> : null}
          {members.error === null ? null : (
            <div className="form-card">
              <ApiErrorNotice error={members.error} />
              <Button type="button" onClick={members.reload}>
                Try again
              </Button>
            </div>
          )}
          {members.data === null ? null : (
            <MemberCollection
              actorRole={organization.role}
              members={members.data}
              onManage={setManagedMember}
            />
          )}
        </section>

        <div className="members-side-column">
          {invitations.status === "loading" ? <LoadingState label="Loading invitations" /> : null}
          {invitations.error === null ? null : <ApiErrorNotice error={invitations.error} />}
          {invitations.data === null ? null : (
            <PendingInvitationRail
              invitations={invitations.data}
              pendingAction={pendingAction}
              onAction={(action, invitation) => void invitationAction(action, invitation)}
            />
          )}
          {organization.role === "owner" ? (
            <InlineNotice tone="warning">
              Re-authentication is required before owner access or organization deletion changes.
            </InlineNotice>
          ) : null}
        </div>
      </div>

      <InviteMemberModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onCreated={() => {
          setSuccess("Invitation sent.");
          invitations.reload();
        }}
      />
      {organization.role === "owner" ? (
        <MemberActionsModal
          member={managedMember}
          onClose={() => setManagedMember(null)}
          onUpdated={members.reload}
        />
      ) : null}
    </div>
  );
}

export function MembersScreen() {
  return (
    <AppBoundary allowedRoles={["owner", "editor"]}>
      {(viewer) => <MembersDataScreen viewer={viewer} />}
    </AppBoundary>
  );
}

function InvitationsDataScreen() {
  const invitations = useApiResource<InvitationsResponse>(apiPaths.invitations);
  const mutation = useMutationState();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function invitationAction(action: "resend" | "revoke", invitation: InvitationSummary) {
    setPendingAction(`${action}:${invitation.id}`);
    setSuccess(null);
    mutation.begin();
    try {
      await postJson(
        apiPaths.invitationAction(invitation.id, action),
        undefined,
        createIdempotencyKey(`${action}-invitation`),
      );
      mutation.clear();
      setPendingAction(null);
      setSuccess(action === "resend" ? "Invitation resent." : "Invitation revoked.");
      invitations.reload();
    } catch (error) {
      setPendingAction(null);
      mutation.fail(error);
    }
  }

  return (
    <div className="screen">
      <ScreenTitle
        title="Invitations"
        description="Invite editor or member roles and review invitation status."
        action={
          <Button className="button--primary" type="button" onClick={() => setInviteOpen(true)}>
            Invite member
          </Button>
        }
      />
      <ApiErrorNotice error={mutation.error} />
      {success === null ? null : <InlineNotice tone="success">{success}</InlineNotice>}
      {invitations.status === "loading" ? <LoadingState label="Loading invitations" /> : null}
      {invitations.error === null ? null : (
        <div className="form-card">
          <ApiErrorNotice error={invitations.error} />
          <Button type="button" onClick={invitations.reload}>
            Try again
          </Button>
        </div>
      )}
      {invitations.data !== null && invitations.data.items.length === 0 ? (
        <EmptyPanel title="No invitations yet">
          <p>Invite a person with an editor or member role.</p>
          <Button className="button--primary" type="button" onClick={() => setInviteOpen(true)}>
            Invite member
          </Button>
        </EmptyPanel>
      ) : null}
      {invitations.data === null || invitations.data.items.length === 0 ? null : (
        <div className="invitation-collection">
          <ul aria-label="Organization invitations">
            {invitations.data.items.map((invitation) => (
              <li key={invitation.id}>
                <div className="invitation-identity">
                  <Avatar displayName={invitation.email} email={invitation.email} />
                  <span>
                    <strong>{invitation.email}</strong>
                    <small>Created {formatDateUtc(invitation.createdAt)}</small>
                  </span>
                </div>
                <RoleBadge role={invitation.role} />
                <div>
                  <StatusBadge
                    label={
                      invitation.status[0]?.toLocaleUpperCase("en") + invitation.status.slice(1)
                    }
                    tone={statusTone(invitation.status)}
                  />
                  <small className="invitation-expiry">
                    {invitationExpiryLabel(invitation.expiresAt)}
                  </small>
                </div>
                <div className="inline-actions">
                  {invitation.status === "pending" ? (
                    <>
                      <Button
                        className="button--text"
                        disabled={pendingAction !== null}
                        type="button"
                        onClick={() => void invitationAction("resend", invitation)}
                      >
                        Resend
                      </Button>
                      <Button
                        className="button--text button--text-danger"
                        disabled={pendingAction !== null}
                        type="button"
                        onClick={() => void invitationAction("revoke", invitation)}
                      >
                        Revoke
                      </Button>
                    </>
                  ) : (
                    <span className="muted-copy">No actions</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="collection-footer">
            Showing {invitations.data.items.length} of {invitations.data.total} invitations
          </p>
        </div>
      )}
      <InviteMemberModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onCreated={() => {
          setSuccess("Invitation sent.");
          invitations.reload();
        }}
      />
    </div>
  );
}

export function InvitationsScreen() {
  return (
    <AppBoundary allowedRoles={["owner", "editor"]}>{() => <InvitationsDataScreen />}</AppBoundary>
  );
}
