import { jsonResponse, withMonitoringAuth } from "../../../../lib/http/api.ts";
import { getMonitoringRepository } from "../../../../lib/monitoring/factory.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withMonitoringAuth(request, async () =>
    jsonResponse(await getMonitoringRepository().application()),
  );
}
