"use client";

export default function MonitoringError({ reset }: Readonly<{ error: Error; reset: () => void }>) {
  return (
    <div className="page">
      <div className="panel empty-state" role="alert">
        <h1>Monitoring view unavailable</h1>
        <p>The view could not be rendered. Authentication and internal data remain protected.</p>
        <button className="button" onClick={reset} type="button">
          Try again
        </button>
      </div>
    </div>
  );
}
