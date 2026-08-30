const expectedNode = "24.20.0";
const expectedPnpm = "11.21.0";
const actualNode = process.versions.node;
const actualPnpm = process.env.npm_config_user_agent?.match(/pnpm\/([^\s]+)/u)?.[1];

if (actualNode !== expectedNode) {
  console.error(`Esmii requires Node.js ${expectedNode}; found ${actualNode}.`);
  process.exit(1);
}

if (actualPnpm !== expectedPnpm) {
  console.error(`Esmii requires pnpm ${expectedPnpm}; found ${actualPnpm ?? "unknown"}.`);
  process.exit(1);
}
