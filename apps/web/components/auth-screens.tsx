"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

import {
  apiPaths,
  createIdempotencyKey,
  postJson,
  providerLabel,
  roleLabel,
  startSocialSignIn,
  type AuthResultResponse,
  type AuthResultState,
  type InvitationResponse,
  type PublicConfig,
  type PublicProvider,
} from "../lib/api";
import { useApiResource, useMutationState } from "../lib/hooks";
import { ApiErrorNotice, Brand, Button, Field, InlineNotice, LoadingState, PageState } from "./ui";

function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className="public-shell">
      <header className="public-header">
        <Link href="/" aria-label="Esmii home">
          <Brand />
        </Link>
      </header>
      <main className="public-main">{children}</main>
    </div>
  );
}

function emailValidationMessage(email: string): string | null {
  const normalized = email.trim();
  if (normalized.length === 0) return "Enter your email address.";
  if (!/^\S+@\S+\.\S+$/u.test(normalized)) return "Enter a complete email address.";
  return null;
}

export function SignInScreen() {
  const router = useRouter();
  const config = useApiResource<PublicConfig>(apiPaths.publicConfig);
  const mutation = useMutationState();
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [providerPending, setProviderPending] = useState<PublicProvider["id"] | null>(null);

  async function requestMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationMessage = emailValidationMessage(email);
    setEmailError(validationMessage);
    if (validationMessage !== null) return;

    mutation.begin();
    try {
      await postJson(
        apiPaths.magicLinkRequest,
        { email: email.trim() },
        createIdempotencyKey("magic-link-request"),
      );
      mutation.clear();
      router.push("/sign-in/check-email");
    } catch (error) {
      mutation.fail(error);
    }
  }

  async function continueWithProvider(provider: PublicProvider) {
    setProviderPending(provider.id);
    mutation.clear();
    try {
      await startSocialSignIn(provider);
    } catch (error) {
      setProviderPending(null);
      mutation.fail(error);
    }
  }

  const enabledProviders = config.data?.providers.filter((provider) => provider.enabled) ?? [];

  return (
    <PublicShell>
      <section className="auth-card" aria-labelledby="sign-in-title">
        <div className="auth-card__heading">
          <p className="eyebrow">Passwordless access</p>
          <h1 id="sign-in-title">Sign in to {config.data?.applicationName ?? "Esmii"}</h1>
          <p>Enter your email address and we’ll send you a secure sign-in link.</p>
        </div>

        <form className="auth-form" noValidate onSubmit={(event) => void requestMagicLink(event)}>
          <Field label="Email address" error={emailError}>
            <input
              autoComplete="email"
              autoFocus
              className="text-input text-input--large"
              disabled={mutation.pending}
              inputMode="email"
              name="email"
              spellCheck={false}
              type="email"
              value={email}
              aria-invalid={emailError === null ? undefined : true}
              onChange={(event) => {
                setEmail(event.currentTarget.value);
                if (emailError !== null) setEmailError(null);
              }}
            />
          </Field>
          <Button
            className="button--primary button--large button--full"
            disabled={mutation.pending}
            type="submit"
          >
            {mutation.pending ? "Requesting link…" : "Email me a sign-in link"}
          </Button>
          <p className="auth-form__privacy">
            If the address can sign in, an email will arrive shortly.
          </p>
        </form>

        <ApiErrorNotice error={mutation.error} />

        {config.status === "loading" ? <LoadingState label="Loading sign-in methods" /> : null}
        {config.status === "error" ? (
          <InlineNotice tone="warning">
            Social sign-in methods are temporarily unavailable. Email sign-in is still available.
          </InlineNotice>
        ) : null}
        {enabledProviders.length === 0 ? null : (
          <div className="provider-section">
            <div className="divider" aria-hidden="true">
              <span>or continue with</span>
            </div>
            <div className="provider-list">
              {enabledProviders.map((provider) => (
                <Button
                  key={provider.id}
                  className="button--provider button--full"
                  disabled={providerPending !== null}
                  type="button"
                  onClick={() => void continueWithProvider(provider)}
                >
                  {providerPending === provider.id
                    ? `Opening ${providerLabel(provider.id)}…`
                    : `Continue with ${providerLabel(provider.id)}`}
                </Button>
              ))}
            </div>
          </div>
        )}

        <p className="security-note">
          No password required. Sign-in links expire after 10 minutes.
        </p>
      </section>
    </PublicShell>
  );
}

export function CheckEmailScreen() {
  return (
    <PublicShell>
      <section className="auth-card auth-card--compact" aria-labelledby="check-email-title">
        <div className="auth-card__heading">
          <p className="eyebrow">Sign-in link requested</p>
          <h1 id="check-email-title">Check your email</h1>
          <p>
            If the address can sign in, the latest message contains a secure link. You can close
            this page.
          </p>
        </div>
        <InlineNotice tone="success">The request was accepted.</InlineNotice>
        <Link className="text-link text-link--center" href="/sign-in">
          Use a different email address
        </Link>
      </section>
    </PublicShell>
  );
}

const authResultCopy: Readonly<Record<AuthResultState, { description: string; title: string }>> = {
  expired: {
    title: "This sign-in link has expired",
    description: "Sign-in links are valid for 10 minutes. Request a new link to continue.",
  },
  invalid: {
    title: "This sign-in link is not valid",
    description: "The link could not be verified. Request a new link to continue.",
  },
  provider_cancelled: {
    title: "Sign-in was cancelled",
    description: "No changes were made. You can try the provider again or use an email link.",
  },
  provider_failed: {
    title: "Sign-in could not be completed",
    description:
      "The provider did not complete sign-in. Try again without sharing any provider details.",
  },
  superseded: {
    title: "A newer sign-in link was requested",
    description: "Open the latest email or request another sign-in link.",
  },
  unsafe_link_rejected: {
    title: "This sign-in method was not linked",
    description:
      "Sign in to your existing account first, then link the provider from account settings.",
  },
  used: {
    title: "This sign-in link has already been used",
    description: "Each link works once. Request a new link to sign in again.",
  },
};

export function AuthResultScreen() {
  const result = useApiResource<AuthResultResponse>(apiPaths.authResult);

  if (result.status === "loading") {
    return (
      <PublicShell>
        <LoadingState label="Checking sign-in result" />
      </PublicShell>
    );
  }

  const copy = result.data === null ? null : authResultCopy[result.data.state];
  return (
    <PublicShell>
      <PageState
        title={copy?.title ?? "Sign-in could not be completed"}
        description={
          copy?.description ?? "Request a new sign-in link or try an available provider."
        }
        tone="danger"
        action={
          <Link className="button button--primary" href="/sign-in">
            Return to sign in
          </Link>
        }
      />
    </PublicShell>
  );
}

function invitationCopy(invitation: InvitationResponse): { description: string; title: string } {
  switch (invitation.state) {
    case "needs_authentication":
      return {
        title: "Sign in to review this invitation",
        description: "Use the verified email address that received the invitation.",
      };
    case "wrong_email":
      return {
        title: "This invitation belongs to another account",
        description: "Sign out and use the verified email address that received the invitation.",
      };
    case "expired":
      return {
        title: "This invitation has expired",
        description: "Ask an organization owner or editor to send a new invitation.",
      };
    case "revoked":
      return {
        title: "This invitation was revoked",
        description: "It can no longer be accepted.",
      };
    case "consumed":
      return {
        title: "This invitation has already been used",
        description: "Open your organizations to continue.",
      };
    case "organization_deleted":
      return {
        title: "This invitation is no longer available",
        description: "The organization cannot accept new members.",
      };
    case "accepted":
      return {
        title: "Invitation accepted",
        description: "The organization is now available in your organization list.",
      };
    case "ready":
      return {
        title: `Join ${invitation.organization?.displayName ?? "this organization"}`,
        description: `You will join as ${invitation.role === undefined ? "a member" : roleLabel(invitation.role).toLocaleLowerCase("en")}.`,
      };
  }
}

export function InvitationScreen() {
  const invitation = useApiResource<InvitationResponse>(apiPaths.invitation);
  const mutation = useMutationState();

  async function acceptInvitation() {
    mutation.begin();
    try {
      await postJson(
        apiPaths.acceptInvitation,
        undefined,
        createIdempotencyKey("accept-invitation"),
      );
      mutation.clear();
      invitation.reload();
    } catch (error) {
      mutation.fail(error);
      invitation.reload();
    }
  }

  if (invitation.status === "loading") {
    return (
      <PublicShell>
        <LoadingState label="Checking invitation" />
      </PublicShell>
    );
  }

  if (invitation.error !== null || invitation.data === null) {
    return (
      <PublicShell>
        <PageState
          title="This invitation could not be checked"
          description="Try again. If the problem continues, request a new invitation."
          tone="danger"
          action={
            <Button type="button" onClick={invitation.reload}>
              Try again
            </Button>
          }
        />
      </PublicShell>
    );
  }

  const copy = invitationCopy(invitation.data);
  const isReady = invitation.data.state === "ready";
  const needsAuthentication = invitation.data.state === "needs_authentication";
  const accepted = invitation.data.state === "accepted" || invitation.data.state === "consumed";

  return (
    <PublicShell>
      <section className="auth-card auth-card--compact" aria-labelledby="invitation-title">
        <div className="auth-card__heading">
          <p className="eyebrow">Organization invitation</p>
          <h1 id="invitation-title">{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
        <ApiErrorNotice error={mutation.error} />
        <div className="stacked-actions">
          {isReady ? (
            <Button
              className="button--primary button--large"
              disabled={mutation.pending}
              type="button"
              onClick={() => void acceptInvitation()}
            >
              {mutation.pending ? "Accepting…" : "Accept invitation"}
            </Button>
          ) : null}
          {needsAuthentication ? (
            <Link className="button button--primary button--large" href="/sign-in">
              Sign in
            </Link>
          ) : null}
          {accepted ? (
            <Link className="button button--primary button--large" href="/app/organizations">
              Open organizations
            </Link>
          ) : null}
          {!isReady && !needsAuthentication && !accepted ? (
            <Link className="button button--secondary" href="/app">
              Return to Esmii
            </Link>
          ) : null}
        </div>
      </section>
    </PublicShell>
  );
}
