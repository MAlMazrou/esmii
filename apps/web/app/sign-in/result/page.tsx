import type { Metadata } from "next";

import { AuthResultScreen } from "../../../components/auth-screens";

export const metadata: Metadata = { title: "Sign-in result" };

export default function SignInResultPage() {
  return <AuthResultScreen />;
}
