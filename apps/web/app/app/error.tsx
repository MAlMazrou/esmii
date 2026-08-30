"use client";

import { Button, PageState } from "../../components/ui";

export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <PageState
      title="This page could not be loaded"
      description="Your account is still safe. Try loading the page again."
      tone="danger"
      action={
        <Button type="button" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
