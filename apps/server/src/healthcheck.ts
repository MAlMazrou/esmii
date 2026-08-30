const rawPort = process.env.PORT ?? "3000";
const port = /^\d+$/.test(rawPort) ? Number(rawPort) : 3000;

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/health/live`, {
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });
  const body: unknown = await response.json();

  if (
    !response.ok ||
    typeof body !== "object" ||
    body === null ||
    !("status" in body) ||
    body.status !== "ok"
  ) {
    process.exitCode = 1;
  }
} catch {
  process.exitCode = 1;
}
