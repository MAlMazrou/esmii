import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalDockerInvocation, spawnLocalDocker } from "./local-docker.mjs";

const images = [
  { dockerfile: "apps/web/Dockerfile", kind: "web", tag: "esmii/web:prompt02" },
  { dockerfile: "apps/server/Dockerfile", kind: "server", tag: "esmii/server:prompt02" },
];

const developmentProvenance = {
  revision: "development-uncommitted",
  source: "local://esmii/working-tree",
};

function resolveImageProvenance(environment = process.env) {
  const configuredSource = environment.ESMII_IMAGE_SOURCE;
  const configuredRevision = environment.ESMII_IMAGE_REVISION;

  if (configuredSource === undefined && configuredRevision === undefined) {
    if (environment.GITHUB_ACTIONS === "true") {
      throw new Error("GitHub Actions must provide explicit image provenance inputs.");
    }
    return developmentProvenance;
  }

  if (configuredSource === undefined || configuredRevision === undefined) {
    throw new Error("Image source and revision provenance must be provided together.");
  }
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(configuredSource)) {
    throw new Error("Image source provenance must be an exact GitHub repository URL.");
  }
  if (!/^[0-9a-f]{40}$/u.test(configuredRevision)) {
    throw new Error("Image revision provenance must be one full lowercase Git SHA.");
  }

  if (environment.GITHUB_ACTIONS === "true") {
    const expectedSource = `${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}`;
    if (configuredSource !== expectedSource || configuredRevision !== environment.GITHUB_SHA) {
      throw new Error("Image provenance does not match the GitHub Actions source revision.");
    }
  }

  return { revision: configuredRevision, source: configuredSource };
}

let provenance;
try {
  provenance = resolveImageProvenance();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let docker;
try {
  docker = createLocalDockerInvocation();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function run(arguments_, options = {}) {
  const result = spawnLocalDocker(docker, arguments_, { stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function dockerOutput(arguments_) {
  const result = spawnLocalDocker(docker, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("A local Docker inspection failed.");
  return result.stdout.trim();
}

function containsForbidden(contents, forbidden) {
  return forbidden.some((value) => contents.includes(value));
}

function scanSavedImage(image, forbidden) {
  const directory = mkdtempSync(join(tmpdir(), "esmii-image-scan-"));
  const archive = join(directory, "image.tar");
  let failureMessage;
  let failureStatus = 1;

  try {
    const saved = spawnLocalDocker(docker, ["image", "save", "--output", archive, image], {
      stdio: "inherit",
    });
    if (saved.status !== 0) {
      failureMessage = `Could not save ${image} for layer scanning.`;
      failureStatus = saved.status ?? 1;
    } else {
      const grepArguments = ["-a", "-F", "-q"];
      for (const value of forbidden) grepArguments.push("-e", value);
      grepArguments.push(archive);

      const result = spawnSync("grep", grepArguments, { stdio: "ignore" });
      if (result.status === 0) {
        failureMessage = `${image} contains a forbidden sentinel in its saved layers.`;
      } else if (result.status !== 1) {
        failureMessage = `Could not scan the saved layers for ${image}.`;
        failureStatus = result.status ?? 1;
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }

  if (failureMessage !== undefined) {
    console.error(failureMessage);
    process.exit(failureStatus);
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function removeFixture(name) {
  const result = spawnLocalDocker(docker, ["container", "rm", "--force", name], {
    stdio: "ignore",
  });
  if (result.status !== 0) {
    throw new Error(`Could not remove runtime fixture ${name}.`);
  }
}

function waitForFixture(name, probeArguments) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = spawnLocalDocker(docker, ["exec", name, ...probeArguments], {
      stdio: "ignore",
    });
    if (result.status === 0) return;
    sleep(250);
  }

  spawnLocalDocker(docker, ["logs", "--tail", "30", name], { stdio: "inherit" });
  throw new Error(`Runtime fixture ${name} did not become ready.`);
}

function runRuntimeFixture({ environmentName, image, kind, port }) {
  const suffix = randomBytes(4).toString("hex");
  const name = `esmii-${kind}-${environmentName}-${suffix}`;
  const expectedImageId = dockerOutput(["image", "inspect", "--format", "{{.Id}}", image]);
  const arguments_ = [
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:size=32m,noexec,nosuid,nodev",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "128",
    "--memory",
    "256m",
    "--env",
    `APP_ENV=${environmentName}`,
    "--env",
    `PORT=${port}`,
  ];

  if (kind === "server") {
    arguments_.push(
      "--env",
      "HOST=127.0.0.1",
      "--env",
      `APP_DATABASE_URL=postgresql://${environmentName}-runtime@fixture.invalid/esmii`,
      "--env",
      `APP_VALKEY_URL=redis://${environmentName}-runtime@fixture.invalid/0`,
      "--env",
      `APP_PUBLIC_ORIGIN=https://${environmentName}.example.invalid`,
      "--env",
      `BETTER_AUTH_SECRET=INERT_${environmentName.toUpperCase()}_BETTER_AUTH_SECRET_00000001`,
      "--env",
      `OPERATIONS_HEALTH_TOKEN=INERT_${environmentName.toUpperCase()}_RUNTIME_FIXTURE_TOKEN_0001`,
    );
    if (environmentName === "staging") {
      arguments_.push("--env", "AUTH_STAGING_TESTER_EMAILS=synthetic.tester@example.invalid");
    }
  } else {
    arguments_.push("--env", "HOSTNAME=127.0.0.1");
  }

  let fixtureImageId;
  let fixtureError;
  let startedSuccessfully = false;
  try {
    const runtimeCommand =
      kind === "server"
        ? [
            "node",
            "--input-type=module",
            "-e",
            "import { loadHttpServerConfig } from '@esmii/config/server'; await loadHttpServerConfig(); setInterval(() => undefined, 60000);",
          ]
        : [];
    const started = spawnLocalDocker(docker, [...arguments_, image, ...runtimeCommand], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (started.status !== 0) throw new Error(`Could not start ${kind} runtime fixture.`);
    startedSuccessfully = true;

    const containerImageId = dockerOutput(["container", "inspect", "--format", "{{.Image}}", name]);
    if (containerImageId !== expectedImageId) {
      throw new Error(`${kind} runtime fixture did not use the expected image identity.`);
    }

    const probe =
      kind === "server"
        ? [
            "node",
            "--input-type=module",
            "-e",
            `import { loadHttpServerConfig } from '@esmii/config/server'; const config = await loadHttpServerConfig(); if (config.appEnvironment !== '${environmentName}' || config.port !== ${port} || config.authentication.publicOrigin !== 'https://${environmentName}.example.invalid') process.exit(1);`,
          ]
        : [
            "node",
            "-e",
            `fetch('http://127.0.0.1:${port}/').then(async (response) => { const body = await response.text(); if (!response.ok || !body.includes('Opening Esmii')) process.exit(1); }).catch(() => process.exit(1));`,
          ];
    waitForFixture(name, probe);
    fixtureImageId = expectedImageId;
  } catch (error) {
    fixtureError = error;
  }

  let cleanupError;
  if (startedSuccessfully) {
    try {
      removeFixture(name);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (fixtureError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [fixtureError, cleanupError],
      `${kind} fixture and cleanup both failed.`,
    );
  }
  if (fixtureError !== undefined) throw fixtureError;
  if (cleanupError !== undefined) throw cleanupError;
  if (typeof fixtureImageId !== "string") {
    throw new Error(`${kind} runtime fixture produced no image identity.`);
  }
  return fixtureImageId;
}

function runRuntimeFixtures() {
  const identities = { server: new Set(), web: new Set() };
  const fixtures = [
    { environmentName: "staging", portOffset: 0 },
    { environmentName: "production", portOffset: 1 },
  ];

  for (const fixture of fixtures) {
    identities.web.add(
      runRuntimeFixture({
        environmentName: fixture.environmentName,
        image: "esmii/web:prompt02",
        kind: "web",
        port: 3201 + fixture.portOffset,
      }),
    );
    identities.server.add(
      runRuntimeFixture({
        environmentName: fixture.environmentName,
        image: "esmii/server:prompt02",
        kind: "server",
        port: 3101 + fixture.portOffset,
      }),
    );
  }

  if (identities.web.size !== 1 || identities.server.size !== 1) {
    throw new Error("Runtime fixtures did not preserve one exact image identity per workload.");
  }
  console.log(
    "The exact web and server image identities passed isolated staging and production runtime fixtures.",
  );
}

if (process.argv[2] === "build") {
  for (const image of images) {
    run([
      "build",
      "--build-arg",
      `ESMII_IMAGE_SOURCE=${provenance.source}`,
      "--build-arg",
      `ESMII_IMAGE_REVISION=${provenance.revision}`,
      "--file",
      image.dockerfile,
      "--tag",
      image.tag,
      ".",
    ]);
  }
} else if (process.argv[2] === "scan") {
  const forbidden = [
    "esmii.app",
    "staging.esmii.app",
    "OAUTH_CLIENT_ID_SENTINEL",
    "COOKIE_SECRET_SENTINEL",
    "MAIL_HOST_SENTINEL",
    "SERVER_SECRET_SENTINEL",
  ];

  for (const image of images) {
    const inspected = spawnLocalDocker(docker, ["image", "inspect", image.tag], {
      encoding: "utf8",
    });
    if (inspected.status !== 0) {
      console.error(`Could not inspect ${image.tag}.`);
      process.exit(inspected.status ?? 1);
    }

    const inspection = JSON.parse(inspected.stdout);
    const labels = inspection[0]?.Config?.Labels;
    const runtimeUser = inspection[0]?.Config?.User;
    if (typeof runtimeUser !== "string" || runtimeUser.length === 0 || runtimeUser === "0") {
      console.error(`${image.tag} does not declare a non-root runtime user.`);
      process.exit(1);
    }
    if (
      labels?.["org.opencontainers.image.source"] !== provenance.source ||
      labels?.["org.opencontainers.image.revision"] !== provenance.revision
    ) {
      console.error(`${image.tag} does not carry the expected OCI source and revision labels.`);
      process.exit(1);
    }
    if (containsForbidden(inspected.stdout, forbidden)) {
      console.error(`${image.tag} contains a forbidden sentinel in image configuration.`);
      process.exit(1);
    }

    const history = spawnLocalDocker(
      docker,
      ["image", "history", "--no-trunc", "--format", "{{json .CreatedBy}}", image.tag],
      { encoding: "utf8" },
    );
    if (history.status !== 0) {
      console.error(`Could not inspect the build history for ${image.tag}.`);
      process.exit(history.status ?? 1);
    }
    if (containsForbidden(history.stdout, forbidden)) {
      console.error(`${image.tag} contains a forbidden sentinel in image history.`);
      process.exit(1);
    }

    const scan = spawnLocalDocker(
      docker,
      [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        image.tag,
        "-c",
        `if grep -R -a -F -q ${forbidden.map((value) => `-e '${value}'`).join(" ")} /app 2>/dev/null; then exit 1; fi`,
      ],
      { stdio: "inherit" },
    );
    if (scan.status !== 0) process.exit(scan.status ?? 1);

    if (image.kind === "server") {
      const publicMediaBoundary = spawnLocalDocker(
        docker,
        [
          "run",
          "--rm",
          "--entrypoint",
          "sh",
          image.tag,
          "-c",
          "test \"$(stat -c '%u:%g:%a' /srv/media/public/variants)\" = '0:0:755' && test -z \"$(find /srv/media/public/variants -mindepth 1 -maxdepth 1 -print -quit)\" && test ! -w /srv/media/public/variants",
        ],
        { stdio: "inherit" },
      );
      if (publicMediaBoundary.status !== 0) {
        console.error(
          `${image.tag} does not keep the initial public variants tree empty and root-owned.`,
        );
        process.exit(publicMediaBoundary.status ?? 1);
      }
    }

    scanSavedImage(image.tag, forbidden);
  }

  console.log(
    "Image user, OCI provenance, configuration, filesystem, history, and layer scans passed.",
  );
} else if (process.argv[2] === "runtime-fixtures") {
  try {
    runRuntimeFixtures();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else {
  console.error("Usage: images.mjs <build|scan|runtime-fixtures>");
  process.exit(1);
}
