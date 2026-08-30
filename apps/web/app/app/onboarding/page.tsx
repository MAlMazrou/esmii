import type { Metadata } from "next";

import { OnboardingScreen } from "../../../components/organization-screens";

export const metadata: Metadata = { title: "Organization setup" };

export default function OnboardingPage() {
  return <OnboardingScreen />;
}
