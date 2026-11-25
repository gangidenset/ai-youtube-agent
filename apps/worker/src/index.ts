import { ConfigError, loadConfig } from "@aya/config";
import { createDefaultRegistry } from "@aya/platforms";

// ジョブ処理（BullMQ）は Issue #5 で実装する。
try {
  const config = loadConfig();
  for (const warning of config.providers.warnings) console.warn(`[worker] ${warning}`);
  const targets = createDefaultRegistry()
    .list()
    .map((c) => c.id);
  console.log(
    `[worker] started (video: ${config.providers.video.join(" > ")}, tts: ${config.providers.tts.join(" > ")}, targets: ${targets.join(", ")})`,
  );
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
