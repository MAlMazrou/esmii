import { spawnSync } from "node:child_process";

import { readPublicAppVersion, readRawAppVersion } from "./app-version.mjs";
import { nextPreOneVersion } from "./version-policy.mjs";

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(output || `${command} ${arguments_.join(" ")} failed.`);
  }
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

try {
  if (run("git", ["status", "--porcelain"]) !== "") {
    throw new Error("Release preparation requires a clean working tree.");
  }

  const tags = run("git", ["tag", "--list", "v[0-9]*", "--sort=-version:refname"])
    .split("\n")
    .filter(Boolean);
  const initialRelease = tags.length === 0;

  if (initialRelease && readPublicAppVersion() !== "v0.1.0") {
    throw new Error("The first Esmii release must be initialized at v0.1.0.");
  }

  const arguments_ = ["pnpm", "exec", "commit-and-tag-version"];
  let expectedVersion = "v0.1.0";
  if (initialRelease) {
    arguments_.push("--first-release");
  } else {
    const currentVersion = readRawAppVersion();
    const commitMessages = run("git", ["log", "--format=%B", `${tags[0]}..HEAD`]);
    expectedVersion = `v${nextPreOneVersion(currentVersion, commitMessages)}`;
    arguments_.push("--release-as", expectedVersion.slice(1));
  }
  run("corepack", arguments_, { stdio: "inherit" });

  // The changelog generator intentionally emits its own Markdown style. Apply
  // the repository formatter before the release commit becomes immutable so
  // the exact tagged tree passes the same lint gate as ordinary source work.
  run("corepack", ["pnpm", "exec", "prettier", "--write", "package.json", "CHANGELOG.md"], {
    stdio: "inherit",
  });
  if (run("git", ["status", "--porcelain", "--", "package.json", "CHANGELOG.md"]) !== "") {
    run("git", ["add", "package.json", "CHANGELOG.md"]);
    run("git", ["commit", "--amend", "--no-edit"]);
    run("git", ["tag", "--force", expectedVersion]);
  }

  const version = readPublicAppVersion();
  if (version !== expectedVersion) {
    throw new Error(`Expected ${expectedVersion}, but release preparation created ${version}.`);
  }
  if (!/^v0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw new Error(`Release ${version} would cross the pre-1.0 boundary.`);
  }
  if (run("git", ["tag", "--points-at", "HEAD"]).split("\n").includes(version) === false) {
    throw new Error(`Release preparation did not create ${version} at the release commit.`);
  }

  console.log(`Prepared ${version}; the protected workflow will retag the merged main commit.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
