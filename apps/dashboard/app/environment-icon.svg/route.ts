import { parsePublicDashboardConfig } from "../../lib/config/server.ts";
import { THEME_COLORS } from "../../design-system/theme.ts";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const environment = parsePublicDashboardConfig().environment;
  const mark =
    environment === "production"
      ? `<rect x="4" y="4" width="24" height="24" rx="5" fill="${THEME_COLORS.info}"/><path d="M10 12h12M10 17h12M10 22h8" stroke="${THEME_COLORS.surface}" stroke-width="2"/>`
      : `<rect x="4" y="4" width="24" height="6" rx="2" fill="${THEME_COLORS.info}"/><rect x="4" y="13" width="24" height="6" rx="2" fill="${THEME_COLORS.info}"/><rect x="4" y="22" width="24" height="6" rx="2" fill="${THEME_COLORS.info}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="${environment} monitoring">${mark}</svg>`;
  return new Response(svg, {
    headers: {
      "cache-control": "no-store",
      "content-type": "image/svg+xml; charset=utf-8",
    },
  });
}
