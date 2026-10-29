import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src";

// SNS 固有の値は targets/ の定義ファイルにだけ置く。それ以外のコードで SNS 名を分岐に使っていないことを確認する。
const SRC = join(import.meta.dirname, "../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("no hard-coded platform names outside targets/", () => {
  const names = createDefaultRegistry()
    .list()
    .flatMap((c) => [c.id, c.platform]);
  const sources = files(SRC).filter((f) => !f.includes(`${join("src", "targets")}`));

  it.each(sources)("%s", (file) => {
    const code = readFileSync(file, "utf8");
    for (const name of new Set(names)) {
      expect(code, `${file} mentions "${name}"`).not.toMatch(new RegExp(`["'\`]${name}["'\`]`));
    }
  });
});
