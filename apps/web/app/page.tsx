"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Brand, Button, LoadingState, PageState } from "../components/ui";
import { apiPaths, type ViewerResponse } from "../lib/api";
import { useApiResource } from "../lib/hooks";

export default function EntryPage() {
  const router = useRouter();
  const viewer = useApiResource<ViewerResponse>(apiPaths.viewer);

  useEffect(() => {
    if (viewer.error?.status === 401) {
      router.replace("/sign-in");
      return;
    }
    if (viewer.status === "ready" && viewer.data !== null) {
      router.replace(viewer.data.activeOrganization === null ? "/app/onboarding" : "/app");
    }
  }, [router, viewer.data, viewer.error, viewer.status]);

  if (viewer.status === "error" && viewer.error?.status !== 401) {
    return (
      <PageState
        title="Esmii could not be opened"
        description="The service could not confirm your session. Try again."
        tone="danger"
        action={
          <Button type="button" onClick={viewer.reload}>
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <div className="route-loading-shell">
      <Brand />
      <LoadingState label="Opening Esmii" />
    </div>
  );
}
