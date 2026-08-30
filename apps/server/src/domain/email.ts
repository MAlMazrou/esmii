export class InvalidEmailError extends Error {
  public constructor() {
    super("Email address is invalid");
    this.name = "InvalidEmailError";
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

/** Case-insensitive canonical form without provider-specific mailbox rewriting. */
export function canonicalizeEmail(value: string): string {
  const canonical = value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
  const at = canonical.indexOf("@");
  if (
    canonical.length < 3 ||
    canonical.length > 320 ||
    at < 1 ||
    at !== canonical.lastIndexOf("@") ||
    at === canonical.length - 1 ||
    /\s/u.test(canonical) ||
    containsControlCharacter(canonical)
  ) {
    throw new InvalidEmailError();
  }
  return canonical;
}
