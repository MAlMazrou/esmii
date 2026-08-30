import type { Metadata } from "next";

import { OrganizationSettingsScreen } from "../../../components/organization-screens";

export const metadata: Metadata = { title: "Organization settings" };

export default function OrganizationSettingsPage() {
  return <OrganizationSettingsScreen />;
}
