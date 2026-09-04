import { errorResponse, jsonResponse, withMonitoringAuth } from "../../../../lib/http/api.ts";
import { getMonitoringRepository } from "../../../../lib/monitoring/factory.ts";
import { parseCursor } from "../../../../lib/monitoring/repository.ts";
import type { LogSeverity } from "../../../../lib/monitoring/types.ts";

export const dynamic = "force-dynamic";

function cleanFilter(value: string | null, maximum: number): string | null | undefined {
  if (value === null || value === "") return null;
  if (
    value.length > maximum ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  )
    return undefined;
  return value;
}

export async function GET(request: Request): Promise<Response> {
  return withMonitoringAuth(request, async () => {
    const url = new URL(request.url);
    const allowed = new Set(["cursor", "limit", "q", "service", "severity"]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
      return errorResponse("INVALID_QUERY", "An unsupported log filter was supplied", 400);
    }
    const rawLimit = url.searchParams.get("limit") ?? "50";
    const limit = /^\d+$/u.test(rawLimit) ? Number(rawLimit) : Number.NaN;
    const service = cleanFilter(url.searchParams.get("service"), 64);
    const search = cleanFilter(url.searchParams.get("q"), 120);
    const rawSeverity = url.searchParams.get("severity");
    const severity: LogSeverity | null | undefined =
      rawSeverity === null || rawSeverity === ""
        ? null
        : rawSeverity === "error" || rawSeverity === "warning"
          ? rawSeverity
          : undefined;
    const rawCursor = url.searchParams.get("cursor");
    const cursor = parseCursor(rawCursor);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      service === undefined ||
      search === undefined ||
      severity === undefined ||
      (rawCursor !== null && cursor === null)
    ) {
      return errorResponse("INVALID_QUERY", "The log filters are invalid", 400);
    }
    return jsonResponse(
      await getMonitoringRepository().logs({ cursor, limit, search, service, severity }),
    );
  });
}
