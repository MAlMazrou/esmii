import { describe, expect, it } from "vitest";

import { canonicalJson, sha256, validateDeploymentRequest } from "../../scripts/infra/core.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const image = (name, character) => `ghcr.io/malmazrou/esmii-${name}@${digest(character)}`;

const policy = {
  allowed_branch: "dev",
  allowed_environment: "staging",
  deployment_epoch: "epoch-1",
  repository: "malmazrou/esmii",
  revoked: false,
  schema_version: 1,
  shared_infrastructure_payload_digest: digest("2"),
  signing_public_key: "/etc/myapp/deployment-policies/github-deployment-public.pem",
};
const policyDigest = sha256(Buffer.from(`${canonicalJson(policy)}\n`));
const production = { activation_manifest_digest: digest("3"), release_id: "active-production" };
const state = {
  active_release_id: "active-staging",
  deployment_epoch: "epoch-1",
  deployment_sequence: 7,
  production,
};
const request = {
  active_compose_files: [
    "infra/compose.yaml",
    "infra/compose.staging.yaml",
    "infra/compose.production.yaml",
  ],
  branch: "dev",
  deployment_epoch: "epoch-1",
  deployment_sequence: 8,
  environment: "staging",
  policy_digest: policyDigest,
  previous_release_id: "active-staging",
  production,
  provenance_verified: true,
  repository: "malmazrou/esmii",
  server_image: image("server", "b"),
  shared_infrastructure_payload_digest: digest("2"),
  signed: true,
  web_image: image("web", "a"),
};

describe("automatic staging policy", () => {
  it("accepts only the next protected-dev staging record while preserving production", () => {
    expect(validateDeploymentRequest(request, policy, state)).toBe(true);
  });

  for (const [label, change, message] of [
    ["unsigned", { signed: false }, "unsigned"],
    ["unattested", { provenance_verified: false }, "unsigned"],
    ["wrong branch", { branch: "main" }, "branch"],
    ["production request", { environment: "production" }, "non-staging"],
    ["replay", { deployment_sequence: 7 }, "replayed"],
    ["wrong epoch", { deployment_epoch: "old" }, "epoch"],
    ["wrong predecessor", { previous_release_id: "older" }, "predecessor"],
    [
      "shared infrastructure",
      { shared_infrastructure_payload_digest: digest("9") },
      "shared infrastructure",
    ],
    ["mutable image", { web_image: "ghcr.io/malmazrou/esmii-web:latest" }, "mutable"],
    ["production mutation", { production: null }, "changed production"],
  ]) {
    it(`rejects ${label}`, () => {
      expect(() => validateDeploymentRequest({ ...request, ...change }, policy, state)).toThrow(
        message,
      );
    });
  }
});
