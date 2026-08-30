import type { Metadata } from "next";

import { OverviewScreen } from "../../components/organization-screens";

export const metadata: Metadata = { title: "Overview" };

export default function OverviewPage() {
  return <OverviewScreen />;
}
