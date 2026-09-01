import { assertPreOneVersion } from "./app-version.mjs";

const breakingHeader = /^[a-z][a-z0-9-]*(?:\([^\r\n)]+\))?!:/mu;
const breakingFooter = /^BREAKING(?: |-)CHANGE:\s+/mu;

export function classifyPreOneBump(commitMessages) {
  return breakingHeader.test(commitMessages) || breakingFooter.test(commitMessages)
    ? "minor"
    : "patch";
}

export function nextPreOneVersion(currentVersion, commitMessages) {
  const version = assertPreOneVersion(currentVersion);
  const [, minor, patch] = version.split(".").map(Number);
  return classifyPreOneBump(commitMessages) === "minor"
    ? `0.${minor + 1}.0`
    : `0.${minor}.${patch + 1}`;
}
