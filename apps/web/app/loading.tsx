import { Brand, LoadingState } from "../components/ui";

export default function RootLoading() {
  return (
    <div className="route-loading-shell">
      <Brand />
      <LoadingState label="Loading Esmii" />
    </div>
  );
}
