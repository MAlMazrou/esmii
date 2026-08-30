import type { Metadata } from "next";

import { SessionsScreen } from "../../../../components/account-screens";

export const metadata: Metadata = { title: "Active sessions" };

export default function SessionsPage() {
  return <SessionsScreen />;
}
