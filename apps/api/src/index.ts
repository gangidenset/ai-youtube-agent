import { ConfigError, loadConfig } from "@aya/config";
import { buildServer } from "./server";

function start() {
  const config = loadConfig();
  const app = buildServer({ logger: true });
  for (const warning of config.providers.warnings) app.log.warn(warning);
  app.log.info({ providers: { ...config.providers, warnings: undefined } }, "provider plan");

  app.listen({ port: config.env.API_PORT, host: "0.0.0.0" }).catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
}

try {
  start();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
