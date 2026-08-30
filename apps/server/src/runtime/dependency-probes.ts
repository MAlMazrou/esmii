import type { DatabaseClient } from "@esmii/database";

import { disabledDependencyProbe, type DependencyProbe } from "../health/dependencies.js";
import { pingValkey } from "./valkey-probe.js";

export function createRuntimeDependencyProbes(
  database: DatabaseClient,
  valkeyUrl: string,
): readonly DependencyProbe[] {
  return [
    {
      name: "postgresql",
      requiredForReadiness: true,
      async check() {
        await database.ping();
        return { status: "ok" };
      },
    },
    {
      name: "valkey",
      requiredForReadiness: false,
      async check() {
        await pingValkey(valkeyUrl);
        return { status: "ok" };
      },
    },
    disabledDependencyProbe("storage"),
    disabledDependencyProbe("queue"),
    disabledDependencyProbe("mail"),
  ];
}
