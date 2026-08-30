import type { Metadata } from "next";

import { InvitationsScreen } from "../../../components/member-screens";

export const metadata: Metadata = { title: "Invitations" };

export default function InvitationsPage() {
  return <InvitationsScreen />;
}
