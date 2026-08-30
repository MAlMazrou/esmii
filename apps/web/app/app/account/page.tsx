import type { Metadata } from "next";

import { AccountScreen } from "../../../components/account-screens";

export const metadata: Metadata = { title: "Account settings" };

export default function AccountPage() {
  return <AccountScreen />;
}
