import type { ApiErrorResponse } from "../monitoring/types.ts";
import { requireOperatorSession } from "../auth/server.ts";

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    headers: {
      "cache-control": "private, no-store, max-age=0",
      "content-type": "application/json; charset=utf-8",
      vary: "cookie",
    },
    status,
  });
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
  requestId = crypto.randomUUID(),
): Response {
  const body: ApiErrorResponse = { error: { code, message, requestId } };
  return jsonResponse(body, status);
}

export async function withMonitoringAuth(
  request: Request,
  handler: () => Promise<Response>,
  authenticate: typeof requireOperatorSession = requireOperatorSession,
): Promise<Response> {
  const requestId = request.headers.get("x-request-id")?.slice(0, 96) || crypto.randomUUID();
  try {
    const operator = await authenticate(new Headers(request.headers));
    if (operator === null) {
      return errorResponse("UNAUTHENTICATED", "Sign in and complete verification", 401, requestId);
    }
    return await handler();
  } catch {
    return errorResponse(
      "MONITORING_UNAVAILABLE",
      "Monitoring data is temporarily unavailable",
      503,
      requestId,
    );
  }
}
