import Link from "next/link";

export default function NotFound() {
  return (
    <main className="auth-page">
      <section className="auth-form-side">
        <div className="auth-card">
          <p className="eyebrow">404</p>
          <h1>Monitoring view not found</h1>
          <p className="auth-copy">This route does not exist in the operator dashboard.</p>
          <Link className="button" href="/overview">
            Return to overview
          </Link>
        </div>
      </section>
    </main>
  );
}
