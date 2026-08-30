import type { Metadata } from "next";

import { OrganizationsScreen } from "../../../components/organization-screens";

export const metadata: Metadata = { title: "Organizations" };

export default function OrganizationsPage() {
  return <OrganizationsScreen />;
}
