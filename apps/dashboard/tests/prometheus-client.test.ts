import { describe, expect, it, vi } from "vitest";

import { PrometheusClient } from "../lib/monitoring/prometheus-client.ts";

describe("PrometheusClient", () => {
  it("uses the fixed API path and validates vector samples", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/v1/query");
      expect(url.searchParams.get("query")).toBe("node_load1");
      return Response.json({
        data: {
          result: [{ metric: { instance: "host" }, value: [1_725_000_000, "0.75"] }],
          resultType: "vector",
        },
        status: "success",
      });
    });
    const client = new PrometheusClient({
      baseUrl: "http://staging-prometheus:9090",
      fetch: request,
      timeoutMs: 1_000,
    });
    const result = await client.query("node_load1", new Date("2026-09-02T00:00:00.000Z"));
    expect(result).toHaveLength(1);
    expect(result[0]?.value).toBe(0.75);
  });

  it("rejects result-type confusion and malformed responses", async () => {
    const client = new PrometheusClient({
      baseUrl: "http://staging-prometheus:9090",
      fetch: async () =>
        Response.json({ data: { result: [], resultType: "matrix" }, status: "success" }),
      timeoutMs: 1_000,
    });
    await expect(client.query("node_load1")).rejects.toThrow(/non-vector/u);
  });

  it("stops reading a streamed response once the fixed byte limit is exceeded", async () => {
    const oversized = new Uint8Array(2_000_001).fill(32);
    const client = new PrometheusClient({
      baseUrl: "http://staging-prometheus:9090",
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(oversized);
              controller.close();
            },
          }),
          { status: 200 },
        ),
      timeoutMs: 1_000,
    });
    await expect(client.query("node_load1")).rejects.toThrow(/oversized response/u);
  });
});
