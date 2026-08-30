import type { Metadata } from "next";

import { InvitationScreen } from "../../components/auth-screens";

export const metadata: Metadata = { title: "Organization invitation" };

export default function InvitationPage() {
  return <InvitationScreen />;
}
