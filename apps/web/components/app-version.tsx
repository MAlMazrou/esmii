import { APP_VERSION } from "../lib/app-version";

export function AppVersion() {
  return (
    <footer className="app-version" aria-label="Application version">
      {APP_VERSION}
    </footer>
  );
}
