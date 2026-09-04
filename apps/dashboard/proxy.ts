import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { requireOperatorSession } from "./lib/auth/server.ts";

/**
 * Reject protected page and RSC/prefetch requests before route rendering.
 * The monitoring layout repeats this full database-backed check, and every
 * typed API has its own gate; this early boundary prevents an unauthenticated
 * response from containing a protected route shell or feature chunk hints.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const operator = await requireOperatorSession(new Headers(request.headers));
  if (operator === null) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/overview/:path*",
    "/services/:path*",
    "/jobs/:path*",
    "/logs/:path*",
    "/application/:path*",
  ],
};
