import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Shell } from "../../components/shell.tsx";
import { requireOperatorSession } from "../../lib/auth/server.ts";
import { parsePublicDashboardConfig } from "../../lib/config/server.ts";

export const dynamic = "force-dynamic";

export default async function MonitoringLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const operator = await requireOperatorSession(new Headers(requestHeaders));
  if (operator === null) redirect("/login");
  const config = parsePublicDashboardConfig();
  return (
    <Shell
      environment={config.environment}
      operatorLabel={operator.email}
      peerOrigin={config.peerOrigin}
    >
      {children}
    </Shell>
  );
}
