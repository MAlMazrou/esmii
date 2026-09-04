"use client";

import { useRef, useState, type FormEvent } from "react";

import type { MonitoringEnvironment } from "../lib/monitoring/types.ts";
import { Brand } from "./brand.tsx";
import { DatabaseIcon, LockIcon, ServerIcon } from "./icons.tsx";

type AuthStep = "credentials" | "password-change" | "totp";

async function responseMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    readonly error?: { readonly message?: unknown };
  } | null;
  return typeof payload?.error?.message === "string"
    ? payload.error.message
    : "Authentication failed";
}

export function AuthScreen({ environment }: Readonly<{ environment: MonitoringEnvironment }>) {
  const [step, setStep] = useState<AuthStep>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  async function submitCredentials(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/operator-auth/sign-in/email", {
        body: JSON.stringify({ email, password }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setStep("totp");
      requestAnimationFrame(() => codeRef.current?.focus());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/operator-auth/two-factor/verify-totp", {
        body: JSON.stringify({ code, trustDevice: false }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const status = await fetch("/api/operator-auth/bootstrap-status", { cache: "no-store" });
      if (!status.ok) throw new Error("Unable to confirm operator setup");
      const state = (await status.json()) as { readonly passwordChangeRequired?: unknown };
      if (state.passwordChangeRequired === true) setStep("password-change");
      else window.location.assign("/overview");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed");
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  async function submitPasswordChange(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (nextPassword.length < 14 || nextPassword !== confirmPassword || nextPassword === password) {
      setError("Use a new password of at least 14 characters and confirm it exactly.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/operator-auth/change-password", {
        body: JSON.stringify({
          currentPassword: password,
          newPassword: nextPassword,
          revokeOtherSessions: true,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      window.location.assign("/overview");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Password change failed");
    } finally {
      setBusy(false);
    }
  }

  const copy =
    step === "credentials"
      ? {
          title: "Operator sign in",
          subtitle: "Use the credentials provisioned for this environment.",
        }
      : step === "totp"
        ? {
            title: "Verify it’s you",
            subtitle: "Enter the six-digit code from your authenticator app.",
          }
        : {
            title: "Replace temporary password",
            subtitle: "Choose the permanent password for this operator realm.",
          };

  return (
    <main className="auth-page">
      <section className="auth-form-side">
        <div className="auth-card">
          <Brand />
          <p className="eyebrow">Private monitoring · {environment}</p>
          <h1>{copy.title}</h1>
          <p className="auth-copy">{copy.subtitle}</p>
          {step === "credentials" ? (
            <form className="auth-form" onSubmit={(event) => void submitCredentials(event)}>
              <label className="form-label">
                Email
                <input
                  autoComplete="username"
                  className="form-input"
                  name="email"
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  type="email"
                  value={email}
                />
              </label>
              <label className="form-label">
                Password
                <input
                  autoComplete="current-password"
                  className="form-input"
                  name="password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </label>
              {error === null ? null : (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <button className="button" disabled={busy} type="submit">
                {busy ? "Checking…" : "Continue"}
              </button>
            </form>
          ) : step === "totp" ? (
            <form className="auth-form" onSubmit={(event) => void submitTotp(event)}>
              <label className="form-label">
                Authenticator code
                <input
                  ref={codeRef}
                  aria-describedby="code-help"
                  autoComplete="one-time-code"
                  className="form-input code-input"
                  inputMode="numeric"
                  maxLength={6}
                  name="code"
                  onChange={(event) => setCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
                  pattern="[0-9]{6}"
                  required
                  value={code}
                />
              </label>
              <span className="sr-only" id="code-help">
                Six numeric digits
              </span>
              {error === null ? null : (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <button className="button" disabled={busy || code.length !== 6} type="submit">
                {busy ? "Verifying…" : "Verify and continue"}
              </button>
              <button
                className="button secondary"
                onClick={() => {
                  setStep("credentials");
                  setError(null);
                  setCode("");
                }}
                type="button"
              >
                Back
              </button>
            </form>
          ) : (
            <form className="auth-form" onSubmit={(event) => void submitPasswordChange(event)}>
              <label className="form-label">
                New password
                <input
                  autoComplete="new-password"
                  className="form-input"
                  minLength={14}
                  onChange={(event) => setNextPassword(event.target.value)}
                  required
                  type="password"
                  value={nextPassword}
                />
              </label>
              <label className="form-label">
                Confirm new password
                <input
                  autoComplete="new-password"
                  className="form-input"
                  minLength={14}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                  type="password"
                  value={confirmPassword}
                />
              </label>
              {error === null ? null : (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <button className="button" disabled={busy} type="submit">
                {busy ? "Saving…" : "Save password"}
              </button>
            </form>
          )}
          <p className="auth-footer">
            No account creation or recovery is available here. Root operators manage access
            separately.
          </p>
        </div>
      </section>
      <aside className="auth-visual" aria-label="Monitoring access boundary">
        <div className="auth-graphic">
          <p className="auth-graphic-label">Authenticated visibility</p>
          <div className="auth-nodes">
            <div className="auth-node">
              <ServerIcon />
              <div>
                <strong>Infrastructure</strong>
                <span>Private metrics</span>
              </div>
            </div>
            <div className="auth-node primary">
              <LockIcon />
              <div>
                <strong>Password + TOTP</strong>
                <span>Environment-isolated operator access</span>
              </div>
            </div>
            <div className="auth-node">
              <DatabaseIcon />
              <div>
                <strong>Prometheus</strong>
                <span>Internal network only</span>
              </div>
            </div>
          </div>
          <span className="environment-chip" data-environment={environment}>
            {environment} realm
          </span>
        </div>
      </aside>
    </main>
  );
}
