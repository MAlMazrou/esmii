import type { Metadata } from "next";

import { MembersScreen } from "../../../components/member-screens";

export const metadata: Metadata = { title: "Members" };

export default function MembersPage() {
  return <MembersScreen />;
}
