import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { AuthScreen } from "../../features/auth/index.ts";
import { requireOperatorSession } from "../../lib/auth/server.ts";
import { parsePublicDashboardConfig } from "../../lib/config/server.ts";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const config = parsePublicDashboardConfig();
  const session = await requireOperatorSession(new Headers(await headers()));
  if (session !== null) redirect("/overview");
  return <AuthScreen environment={config.environment} />;
}
