import type { Metadata } from "next";

import { SignInScreen } from "../../components/auth-screens";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return <SignInScreen />;
}
