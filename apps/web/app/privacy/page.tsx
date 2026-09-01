import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy notice",
};

export default function PrivacyPage() {
  return (
    <main className="legal-shell">
      <div className="legal-page">
        <Link className="brand-link" href="/">
          Esmii
        </Link>
        <p className="eyebrow">Staging privacy notice</p>
        <h1>Privacy during testing</h1>
        <p>
          Esmii uses your email address to create and sign in to your test account. If you use
          Google sign-in, Esmii also receives the basic profile information Google shares with the
          application, such as your name, email address, and profile image when available.
        </p>
        <p>
          Account and organization activity created on this staging service is stored only to run
          and evaluate the application. Staging data is not production data and may be reset or
          deleted as testing continues.
        </p>
        <p>Esmii does not sell this information or use it for advertising.</p>
        <p>
          To ask about your staging data or request deletion of your test account, contact{" "}
          <a href="mailto:support@polytech.ae">support@polytech.ae</a>.
        </p>
        <p className="legal-page__updated">Last updated 31 August 2026.</p>
      </div>
    </main>
  );
}
