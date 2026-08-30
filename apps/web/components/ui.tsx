"use client";

import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type FormEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";

import type { ApiRequestError, OrganizationRole } from "../lib/api";
import { getInitials } from "../lib/format";

export function Brand(): ReactNode {
  return <span className="brand">Esmii</span>;
}

export function Button({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`button ${className}`.trim()} {...props} />;
}

export function InlineNotice({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const role = tone === "danger" ? "alert" : "status";
  return (
    <div className={`notice notice--${tone}`} role={role}>
      {children}
    </div>
  );
}

export function ApiErrorNotice({ error }: { error: ApiRequestError | null }) {
  if (error === null) return null;

  return (
    <InlineNotice tone="danger">
      <strong>{error.message}</strong>
      {error.requestId === null ? null : (
        <span className="request-reference">Reference: {error.requestId}</span>
      )}
    </InlineNotice>
  );
}

export function PageState({
  action,
  description,
  title,
  tone = "neutral",
}: {
  action?: ReactNode;
  description: string;
  title: string;
  tone?: "neutral" | "danger";
}) {
  return (
    <section className={`page-state page-state--${tone}`} aria-labelledby="page-state-title">
      <p className="eyebrow">Esmii</p>
      <h1 id="page-state-title">{title}</h1>
      <p>{description}</p>
      {action === undefined ? null : <div className="page-state__actions">{action}</div>}
    </section>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading-state" role="status" aria-live="polite" aria-busy="true">
      <span className="loading-state__bar" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Avatar({ displayName, email }: { displayName: string; email?: string }) {
  return (
    <span className="avatar" aria-hidden="true">
      {getInitials(displayName, email)}
    </span>
  );
}

export function RoleBadge({ role }: { role: OrganizationRole }) {
  const label = role[0]?.toLocaleUpperCase("en") + role.slice(1);
  return <span className={`role-badge role-badge--${role}`}>{label}</span>;
}

export function StatusBadge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "success" | "warning";
}) {
  return <span className={`status-badge status-badge--${tone}`}>{label}</span>;
}

export function Field({
  children,
  error,
  hint,
  label,
}: {
  children: ReactNode;
  error?: string | null;
  hint?: string;
  label: string;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint === undefined ? null : <span className="field__hint">{hint}</span>}
      {error === undefined || error === null ? null : (
        <span className="field__error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export function Modal({
  children,
  description,
  onClose,
  open,
  title,
}: {
  children: ReactNode;
  description?: string | undefined;
  onClose: () => void;
  open: boolean;
  title: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function handleClose() {
    onClose();
  }

  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    onClose();
  }

  function handleBackdropClick(event: FormEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-describedby={description === undefined ? undefined : descriptionId}
      aria-labelledby={titleId}
      onCancel={handleCancel}
      onClose={handleClose}
      onClick={handleBackdropClick}
    >
      <div className="modal__surface">
        <div className="modal__handle" aria-hidden="true" />
        <div className="modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description === undefined ? null : <p id={descriptionId}>{description}</p>}
          </div>
          <Button className="button--quiet modal__close" type="button" onClick={onClose}>
            Close
          </Button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function EmptyPanel({ children, title }: { children?: ReactNode; title: string }) {
  return (
    <section className="empty-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
