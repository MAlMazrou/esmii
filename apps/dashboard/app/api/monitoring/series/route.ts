import { errorResponse, jsonResponse, withMonitoringAuth } from "../../../../lib/http/api.ts";
import { getMonitoringRepository } from "../../../../lib/monitoring/factory.ts";
import { parseMetricId, parseTimeRange } from "../../../../lib/monitoring/metric-registry.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withMonitoringAuth(request, async () => {
    const url = new URL(request.url);
    const metric = parseMetricId(url.searchParams.get("metric"));
    const range = parseTimeRange(url.searchParams.get("range"));
    if (
      metric === null ||
      range === null ||
      [...url.searchParams.keys()].some((key) => key !== "metric" && key !== "range")
    ) {
      return errorResponse("INVALID_QUERY", "Choose an allowed metric and time range", 400);
    }
    const repository = getMonitoringRepository();
    return jsonResponse({
      environment: repository.environment,
      generatedAt: new Date().toISOString(),
      metric,
      range,
      series: await repository.series(metric, range),
    });
  });
}
