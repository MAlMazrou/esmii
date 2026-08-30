import Link from "next/link";

import { PageState } from "../components/ui";

export default function NotFound() {
  return (
    <PageState
      title="Page not found"
      description="The page you requested is not available."
      action={
        <Link className="button button--primary" href="/">
          Return to Esmii
        </Link>
      }
    />
  );
}
