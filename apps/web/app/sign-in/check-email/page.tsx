import type { Metadata } from "next";

import { CheckEmailScreen } from "../../../components/auth-screens";

export const metadata: Metadata = { title: "Check your email" };

export default function CheckEmailPage() {
  return <CheckEmailScreen />;
}
