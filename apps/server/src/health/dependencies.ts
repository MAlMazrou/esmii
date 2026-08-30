import type {
  DependenciesHealthResponse,
  DependencyHealth,
  DependencyState,
} from "@esmii/contracts";

export interface DependencyProbeResult {
  status: Exclude<DependencyState, "unavailable">;
}

export interface DependencyProbe {
  check(): Promise<DependencyProbeResult>;
  name: string;
  requiredForReadiness: boolean;
}

const dependencyNamePattern = /^[a-z][a-z0-9-]{0,79}$/;

export function validateDependencyProbes(probes: readonly DependencyProbe[]): void {
  const names = new Set<string>();

  for (const probe of probes) {
    if (!dependencyNamePattern.test(probe.name)) {
      throw new TypeError("Dependency probe names must be safe lowercase identifiers");
    }

    if (names.has(probe.name)) {
      throw new TypeError(`Duplicate dependency probe: ${probe.name}`);
    }

    names.add(probe.name);
  }
}

async function runOneProbe(probe: DependencyProbe): Promise<DependencyHealth> {
  const startedAt = performance.now();

  try {
    const result = await probe.check();
    return {
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      requiredForReadiness: probe.requiredForReadiness,
      status: result.status,
    };
  } catch {
    return {
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      requiredForReadiness: probe.requiredForReadiness,
      status: "unavailable",
    };
  }
}

export async function checkDependencies(
  probes: readonly DependencyProbe[],
): Promise<DependenciesHealthResponse> {
  const results = await Promise.all(
    probes.map(async (probe) => [probe.name, await runOneProbe(probe)] as const),
  );
  const dependencies = Object.fromEntries(results);
  const degraded = results.some(([, result]) => result.status !== "ok");

  return {
    checkedAt: new Date().toISOString(),
    dependencies,
    status: degraded ? "degraded" : "ok",
  };
}

export function isReady(
  probes: readonly DependencyProbe[],
  health: DependenciesHealthResponse,
): boolean {
  return probes
    .filter((probe) => probe.requiredForReadiness)
    .every((probe) => health.dependencies[probe.name]?.status === "ok");
}

export function disabledDependencyProbe(
  name: string,
  requiredForReadiness = false,
): DependencyProbe {
  return {
    name,
    requiredForReadiness,
    async check() {
      return { status: "disabled" };
    },
  };
}
