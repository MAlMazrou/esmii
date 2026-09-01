import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { readPublicAppVersion } from "./app-version.mjs";

function git(arguments_) {
  const result = spawnSync("git", arguments_, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Git version check failed.");
  return result.stdout.trim();
}

try {
  const version = readPublicAppVersion();
  const eventName = process.env.GITHUB_EVENT_NAME;
  const branch = process.env.GITHUB_REF;

  if (eventName === "workflow_dispatch") {
    const requestedVersion = process.env.ESMII_RELEASE_VERSION_INPUT;
    const channel = process.env.ESMII_RELEASE_CHANNEL_INPUT;
    if (requestedVersion !== version) {
      throw new Error(
        `Dispatched version ${requestedVersion || "<empty>"} does not match ${version}.`,
      );
    }
    if (branch === "refs/heads/main") {
      if (channel !== "production") throw new Error("Main dispatch requires production channel.");
      const taggedRevision = git(["rev-list", "-n", "1", version]);
      if (taggedRevision !== process.env.GITHUB_SHA) {
        throw new Error(`${version} does not identify the dispatched main revision.`);
      }
    } else if (branch === "refs/heads/dev") {
      if (channel !== "staging") throw new Error("Dev dispatch requires staging channel.");
    } else {
      throw new Error("Release dispatch is limited to dev or main.");
    }
  }

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) appendFileSync(outputPath, `app_version=${version}\n`);
  console.log(`Build context is pinned to ${version}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
