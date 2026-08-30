const englishDateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

export function formatDateUtc(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return englishDateFormatter.format(date);
}

export function getInitials(displayName: string, email?: string): string {
  const words = displayName
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  const source = words.length > 0 ? words : [email ?? "E"];
  const first = source[0]?.[0] ?? "E";
  const second = source.length > 1 ? (source.at(-1)?.[0] ?? "") : "";
  return `${first}${second}`.toLocaleUpperCase("en");
}

export function invitationExpiryLabel(value: string): string {
  const expiry = new Date(value);
  if (Number.isNaN(expiry.getTime())) return "Expiry unavailable";

  const millisecondsPerDay = 86_400_000;
  const days = Math.ceil((expiry.getTime() - Date.now()) / millisecondsPerDay);
  if (days <= 0) return "Expired";
  if (days === 1) return "Expires in 1 day";
  return `Expires in ${days} days`;
}
