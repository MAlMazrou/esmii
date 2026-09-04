const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_SAMPLES = 12_000;

export interface PrometheusSample {
  readonly labels: Readonly<Record<string, string>>;
  readonly timestamp: Date;
  readonly value: number;
}

export interface PrometheusSeries {
  readonly labels: Readonly<Record<string, string>>;
  readonly samples: readonly PrometheusSample[];
}

interface PrometheusEnvelope {
  readonly data?: {
    readonly result?: readonly unknown[];
    readonly resultType?: unknown;
  };
  readonly error?: unknown;
  readonly status?: unknown;
}

function parseLabels(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    if (/^[a-zA-Z_:][a-zA-Z0-9_:]*$/u.test(key) && typeof label === "string") {
      labels[key] = label.slice(0, 256);
    }
  }
  return labels;
}

function parsePair(value: unknown): { readonly timestamp: Date; readonly value: number } | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [rawTimestamp, rawValue] = value;
  const timestamp = typeof rawTimestamp === "number" ? rawTimestamp : Number.NaN;
  const numeric = typeof rawValue === "string" ? Number(rawValue) : Number.NaN;
  if (!Number.isFinite(timestamp) || !Number.isFinite(numeric)) return null;
  const date = new Date(timestamp * 1_000);
  if (!Number.isFinite(date.getTime())) return null;
  return { timestamp: date, value: numeric };
}

async function readLimitedJson(response: Response): Promise<PrometheusEnvelope> {
  const rawDeclaredLength = response.headers.get("content-length");
  const declaredLength = rawDeclaredLength === null ? null : Number(rawDeclaredLength);
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_RESPONSE_BYTES
  ) {
    throw new Error("Prometheus returned an oversized response");
  }
  if (response.body === null) throw new Error("Prometheus returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Prometheus returned an oversized response");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as PrometheusEnvelope;
  } catch {
    throw new Error("Prometheus returned malformed JSON");
  }
}

export class PrometheusClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly baseUrl: string;
    readonly fetch?: typeof fetch;
    readonly timeoutMs: number;
  }) {
    this.#baseUrl = options.baseUrl;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs;
  }

  async #request(
    pathname: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<PrometheusEnvelope> {
    const url = new URL(pathname, `${this.#baseUrl}/`);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const response = await this.#fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error(`Prometheus request failed with status ${response.status}`);
    const envelope = await readLimitedJson(response);
    if (
      envelope.status !== "success" ||
      envelope.data === undefined ||
      !Array.isArray(envelope.data.result)
    ) {
      throw new Error("Prometheus returned an unsuccessful response");
    }
    return envelope;
  }

  async query(query: string, at = new Date()): Promise<readonly PrometheusSample[]> {
    const envelope = await this.#request("api/v1/query", {
      query,
      time: String(at.getTime() / 1_000),
    });
    if (envelope.data?.resultType !== "vector")
      throw new Error("Prometheus returned a non-vector result");
    const samples: PrometheusSample[] = [];
    for (const row of envelope.data.result ?? []) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
      const record = row as { readonly metric?: unknown; readonly value?: unknown };
      const pair = parsePair(record.value);
      if (pair !== null) samples.push({ labels: parseLabels(record.metric), ...pair });
      if (samples.length > MAX_SAMPLES) throw new Error("Prometheus returned too many samples");
    }
    return samples;
  }

  async queryRange(options: {
    readonly end: Date;
    readonly query: string;
    readonly start: Date;
    readonly stepSeconds: number;
  }): Promise<readonly PrometheusSeries[]> {
    const envelope = await this.#request("api/v1/query_range", {
      end: String(options.end.getTime() / 1_000),
      query: options.query,
      start: String(options.start.getTime() / 1_000),
      step: String(options.stepSeconds),
    });
    if (envelope.data?.resultType !== "matrix")
      throw new Error("Prometheus returned a non-matrix result");
    let sampleCount = 0;
    const series: PrometheusSeries[] = [];
    for (const row of envelope.data.result ?? []) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
      const record = row as { readonly metric?: unknown; readonly values?: unknown };
      if (!Array.isArray(record.values)) continue;
      const labels = parseLabels(record.metric);
      const samples: PrometheusSample[] = [];
      for (const raw of record.values) {
        const pair = parsePair(raw);
        if (pair !== null) samples.push({ labels, ...pair });
        sampleCount += 1;
        if (sampleCount > MAX_SAMPLES) throw new Error("Prometheus returned too many samples");
      }
      series.push({ labels, samples });
    }
    return series;
  }
}
