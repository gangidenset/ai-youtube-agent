import { createDefaultRegistry } from "@aya/platforms";

// ジョブ処理（BullMQ）は Issue #5 で実装する。
const targets = createDefaultRegistry()
  .list()
  .map((c) => c.id);
console.log(`[worker] started (platform targets: ${targets.join(", ")})`);
