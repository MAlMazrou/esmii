import { handleOperatorAuthRequest } from "../../../../lib/auth/server.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleOperatorAuthRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleOperatorAuthRequest(request);
}
