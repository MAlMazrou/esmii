let sequence = 0;

export function nextSyntheticId(prefix = "fixture"): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export function nextSyntheticEmail(): string {
  return `${nextSyntheticId("person")}@example.test`;
}

export function resetSyntheticSequence(): void {
  sequence = 0;
}
