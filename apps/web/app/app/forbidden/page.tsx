import Link from "next/link";

import { PageState } from "../../../components/ui";

export default function ForbiddenPage() {
  return (
    <PageState
      title="You do not have access"
      description="Your account cannot open this page."
      action={
        <Link className="button button--primary" href="/app">
          Return to overview
        </Link>
      }
    />
  );
}
