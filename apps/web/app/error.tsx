"use client";

import { Button, PageState } from "../components/ui";

export default function RootError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <PageState
      title="Something went wrong"
      description="Esmii could not finish loading this page. Try again."
      tone="danger"
      action={
        <Button type="button" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
