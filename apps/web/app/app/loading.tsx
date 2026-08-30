import { Brand, LoadingState } from "../../components/ui";

export default function AppLoading() {
  return (
    <div className="route-loading-shell">
      <Brand />
      <LoadingState label="Loading your organization" />
    </div>
  );
}
