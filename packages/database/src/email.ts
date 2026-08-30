const emailPattern = /^[^\s@]+@[^\s@]+$/u;

/**
 * Esmii's single comparison form. It deliberately preserves provider-specific
 * mailbox syntax such as dots and plus tags.
 */
export function canonicalizeEmail(value: string): string {
  const canonical = value.trim().normalize("NFC").toLowerCase();
  if (canonical.length < 3 || canonical.length > 320 || !emailPattern.test(canonical)) {
    throw new TypeError("email must be a valid address between 3 and 320 characters");
  }

  return canonical;
}

export function isCanonicalEmail(value: string): boolean {
  try {
    return canonicalizeEmail(value) === value;
  } catch {
    return false;
  }
}
