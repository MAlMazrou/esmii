import { spawnSync } from "node:child_process";

const composeOverrideVariables = [
  "COMPOSE_ENV_FILES",
  "COMPOSE_FILE",
  "COMPOSE_PATH_SEPARATOR",
  "COMPOSE_PROFILES",
  "COMPOSE_PROJECT_NAME",
];

const builderOverrideVariables = ["BUILDKIT_HOST", "BUILDX_BUILDER"];

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function isLocalDockerEndpoint(endpoint) {
  if (!nonEmpty(endpoint)) return false;
  const normalized = endpoint.trim().toLowerCase();
  return (
    normalized.startsWith("unix://") ||
    normalized.startsWith("npipe://") ||
    normalized.startsWith("fd://")
  );
}

export function sanitizeDockerEnvironment(environment) {
  const sanitized = { ...environment };
  for (const name of [
    ...composeOverrideVariables,
    ...builderOverrideVariables,
    "COMPOSE_BAKE",
    "DOCKER_CERT_PATH",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS_VERIFY",
  ]) {
    delete sanitized[name];
  }
  return sanitized;
}

function readCurrentContext(environment) {
  const result = spawnSync("docker", ["context", "show"], {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.stdout.trim().length === 0) {
    throw new Error("Could not resolve the Docker context for local-only validation.");
  }
  return result.stdout.trim();
}

function readContextEndpoint(contextName, environment) {
  const result = spawnSync(
    "docker",
    ["context", "inspect", contextName, "--format", "{{json .Endpoints.docker.Host}}"],
    {
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error("Could not inspect the Docker context for local-only validation.");
  }

  try {
    const endpoint = JSON.parse(result.stdout.trim());
    if (typeof endpoint !== "string") throw new TypeError("endpoint is not a string");
    return endpoint;
  } catch {
    throw new Error("Docker returned an invalid local context endpoint.");
  }
}

export function createLocalDockerInvocation({
  environment = process.env,
  currentContextReader = readCurrentContext,
  contextEndpointReader = readContextEndpoint,
} = {}) {
  for (const name of builderOverrideVariables) {
    if (nonEmpty(environment[name])) {
      throw new Error(`Refusing local Docker operation while ${name} is set.`);
    }
  }

  const sanitizedEnvironment = sanitizeDockerEnvironment(environment);
  const configuredHost = environment.DOCKER_HOST?.trim();
  if (configuredHost) {
    if (!isLocalDockerEndpoint(configuredHost)) {
      throw new Error("Refusing a non-local Docker endpoint.");
    }
    return {
      arguments: ["--host", configuredHost],
      environment: sanitizedEnvironment,
    };
  }

  const configuredContext = environment.DOCKER_CONTEXT?.trim();
  const contextName = configuredContext || currentContextReader(sanitizedEnvironment);
  const endpoint = contextEndpointReader(contextName, sanitizedEnvironment);
  if (!isLocalDockerEndpoint(endpoint)) {
    throw new Error("Refusing a Docker context whose endpoint is not local.");
  }

  return {
    arguments: ["--context", contextName],
    environment: sanitizedEnvironment,
  };
}

export function spawnLocalDocker(invocation, arguments_, options = {}) {
  if (Object.hasOwn(options, "env")) {
    throw new TypeError("Docker child environment is controlled by the local-only guard.");
  }
  return spawnSync("docker", [...invocation.arguments, ...arguments_], {
    ...options,
    env: invocation.environment,
  });
}

function quoteForLog(argument) {
  return /^[A-Za-z0-9_./:=@{}-]+$/u.test(argument) ? argument : JSON.stringify(argument);
}

export function formatLocalDockerCommand(invocation, arguments_) {
  return ["docker", ...invocation.arguments, ...arguments_].map(quoteForLog).join(" ");
}
