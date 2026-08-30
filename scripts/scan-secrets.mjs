import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { spawnSync } from "node:child_process";

const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
});

if (listed.status !== 0) {
  console.error("Unable to enumerate repository files for the secret scan.");
  process.exit(1);
}

const textExtensions = new Set([
  "",
  ".css",
  ".env",
  ".example",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/u,
  /(?:password|secret|token|private[_-]?key)\s*[:=]\s*["'](?!<|development|test|example|synthetic|sentinel|local-only)[A-Za-z0-9+/=_-]{20,}["']/iu,
  /^(?:[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY)[A-Z0-9_]*)=(?!<|\$\{|\$\(|file:|development|test|example|synthetic|sentinel|local-only)[A-Za-z0-9+/=_-]{20,}$/imu,
];

const findings = [];
for (const file of listed.stdout.split("\n").filter(Boolean)) {
  if (!textExtensions.has(extname(file)) && !file.endsWith("Dockerfile")) continue;
  const contents = await readFile(file, "utf8");
  if (patterns.some((pattern) => pattern.test(contents))) findings.push(file);
}

if (findings.length > 0) {
  console.error(`Potential secret material found in: ${findings.join(", ")}`);
  process.exit(1);
}

console.log("Secret scan passed; no credential-shaped material found.");
