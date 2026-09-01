import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = readFileSync(join(root, ".commitlint-baseline"), "utf8").trim();

function git(arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${arguments_.join(" ")} failed.`);
  }
  return result.stdout.trim();
}

function lintMessage(message, label) {
  const executable = join(root, "node_modules", ".bin", "commitlint");
  const result = spawnSync(executable, ["--verbose"], {
    cwd: root,
    encoding: "utf8",
    input: `${message.trim()}\n`,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new Error(`${label} is not a Conventional Commit.`);
}

function eventDocument() {
  const path = process.env.GITHUB_EVENT_PATH;
  return path ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

function candidateCommits(document) {
  const eventName = process.env.GITHUB_EVENT_NAME;
  let revisionArguments;

  if (eventName === "pull_request") {
    // The protected branches use the pull-request title as the eventual
    // squash/release message. The branch push is checked again after merge.
    return [];
  } else if (eventName === "push") {
    const before = document.before;
    revisionArguments = /^0{40}$/u.test(before)
      ? ["rev-list", "--first-parent", "--reverse", document.after, "--max-count=1"]
      : ["rev-list", "--first-parent", "--reverse", `${before}..${document.after}`];
  } else if (eventName === "workflow_dispatch") {
    revisionArguments = ["rev-list", "--reverse", process.env.GITHUB_SHA, "--max-count=1"];
  } else {
    revisionArguments = ["rev-list", "--first-parent", "--reverse", `${baseline}..HEAD`];
  }

  const output = git(revisionArguments);
  return output.length === 0 ? [] : output.split("\n");
}

try {
  const document = eventDocument();
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    lintMessage(document.pull_request.title, "The pull-request title");
  }

  const revisions = candidateCommits(document);
  for (const revision of revisions) {
    lintMessage(git(["show", "--no-patch", "--format=%B", revision]), `Commit ${revision}`);
  }
  console.log(`Conventional Commit policy passed for ${revisions.length} new commit(s).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
