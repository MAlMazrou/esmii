import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateDevelopmentCompose } from "./development-compose-policy.mjs";
import { withAppVersionEnvironment } from "./app-version.mjs";
import {
  createLocalDockerInvocation,
  formatLocalDockerCommand,
  spawnLocalDocker,
} from "./local-docker.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectName = "esmii-development";
const envPath = join(root, "infra", ".env.development.local");
const composeFiles = [
  join(root, "infra", "compose.yaml"),
  join(root, "infra", "compose.development.yaml"),
];

const commandMap = {
  up: ["up", "-d", "--build", "--wait"],
  down: ["down", "--remove-orphans"],
};

const command = process.argv[2];
const tail = commandMap[command];

if (!tail && command !== "config" && command !== "migrate") {
  console.error("Usage: compose.mjs <config|up|down|migrate>");
  process.exit(1);
}

const args = ["compose", "--project-name", projectName, "--env-file", envPath];
for (const file of composeFiles) args.push("-f", file);

let docker;
try {
  docker = createLocalDockerInvocation({ environment: withAppVersionEnvironment() });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (command === "config") {
  const commandArguments = [...args, "config", "--format", "json"];
  console.log(`Local Docker command: ${formatLocalDockerCommand(docker, commandArguments)}`);
  const result = spawnLocalDocker(docker, commandArguments, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  try {
    const summary = validateDevelopmentCompose(result.stdout, root);
    console.log(
      `Development Compose policy passed for ${summary.applicationServices} non-root application services and ${summary.publishedPorts} loopback-only ports.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}

if (command === "migrate") {
  const buildArguments = [...args, "build", "development-api"];
  console.log(`Local Docker command: ${formatLocalDockerCommand(docker, buildArguments)}`);
  const build = spawnLocalDocker(docker, buildArguments, {
    cwd: root,
    stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);

  const migrationArguments = [...args, "run", "--rm", "development-migrate"];
  console.log(`Local Docker command: ${formatLocalDockerCommand(docker, migrationArguments)}`);
  const migration = spawnLocalDocker(docker, migrationArguments, {
    cwd: root,
    stdio: "inherit",
  });
  process.exit(migration.status ?? 1);
}

const commandArguments = [...args, ...tail];
console.log(`Local Docker command: ${formatLocalDockerCommand(docker, commandArguments)}`);
const result = spawnLocalDocker(docker, commandArguments, { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
