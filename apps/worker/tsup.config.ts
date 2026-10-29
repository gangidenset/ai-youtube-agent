import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // ワークスペース内のパッケージは TS ソースのまま公開しているので、バンドルに含める
  noExternal: [/^@aya\//],
});
