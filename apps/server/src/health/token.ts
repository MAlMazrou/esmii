import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function hasValidOperationsToken(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (authorizationHeader === undefined || !authorizationHeader.startsWith("Bearer ")) {
    return false;
  }

  const suppliedToken = authorizationHeader.slice("Bearer ".length);
  if (suppliedToken.length === 0 || /\s/.test(suppliedToken)) {
    return false;
  }

  return timingSafeEqual(digest(suppliedToken), digest(expectedToken));
}
