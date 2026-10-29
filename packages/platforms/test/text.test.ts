import { describe, expect, it } from "vitest";
import { countLength, normalizeHashtag, normalizeHashtags } from "../src";

describe("countLength", () => {
  it("counts code points for CHAR", () => {
    expect(countLength("AI副業🚀", "CHAR")).toBe(5);
  });

  it("weights CJK as 2 and URLs as 23 for WEIGHTED", () => {
    expect(countLength("abc", "WEIGHTED")).toBe(3);
    expect(countLength("副業", "WEIGHTED")).toBe(4);
    expect(countLength("見て https://example.com/very/long/path", "WEIGHTED")).toBe(4 + 1 + 23);
  });
});

describe("hashtags", () => {
  it("normalizes a single hashtag", () => {
    expect(normalizeHashtag("AI 副業")).toBe("#AI副業");
    expect(normalizeHashtag("##shorts")).toBe("#shorts");
    expect(normalizeHashtag("ai_tips")).toBe("#ai_tips");
    expect(normalizeHashtag("  #  ")).toBeNull();
    expect(normalizeHashtag("「副業」！")).toBe("#副業");
  });

  it("dedupes case-insensitively and applies the limit", () => {
    expect(normalizeHashtags(["#Shorts", "shorts", "AI", "副業", "節約"], 3)).toEqual([
      "#Shorts",
      "#AI",
      "#副業",
    ]);
  });
});
