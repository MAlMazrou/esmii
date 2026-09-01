const appVersion = process.env.NEXT_PUBLIC_APP_VERSION;

if (!appVersion || !/^v0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(appVersion)) {
  throw new Error("NEXT_PUBLIC_APP_VERSION was not inlined during the Next.js build.");
}

export const APP_VERSION = appVersion;
