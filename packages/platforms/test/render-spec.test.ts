import { describe, expect, it } from "vitest";
import { createDefaultRegistry, type MasterRenderInfo, renderCacheKey } from "../src";

const registry = createDefaultRegistry();
const master: MasterRenderInfo = {
  width: 1080,
  height: 1920,
  scenes: [
    { sceneNumber: 1, durationSec: 3, priority: "CORE" },
    { sceneNumber: 2, durationSec: 5, priority: "CORE" },
    { sceneNumber: 3, durationSec: 6, priority: "OPTIONAL" },
    { sceneNumber: 4, durationSec: 6, priority: "CORE" },
    { sceneNumber: 5, durationSec: 5, priority: "OPTIONAL" },
    { sceneNumber: 6, durationSec: 5, priority: "CORE" },
  ],
};

describe("planRender (one 9:16 master → each target)", () => {
  it("keeps 9:16 targets as-is", () => {
    for (const id of ["tiktok", "instagram_reels", "youtube_shorts", "facebook_reels"]) {
      const spec = registry.getAdapter(id).buildRenderSpec(master);
      expect(spec.reframe.mode).toBe("NONE");
      expect(spec.includedScenes).toEqual([1, 2, 3, 4, 5, 6]);
      expect(spec.durationSec).toBe(30);
    }
  });

  it("center-crops to 1:1 for X", () => {
    const spec = registry.getAdapter("x_video").buildRenderSpec(master);
    expect(spec.reframe).toEqual({ mode: "CENTER_CROP", crop: { x: 0, y: 420, width: 1080, height: 1080 } });
    expect(spec.output).toMatchObject({ width: 1080, height: 1080 });
  });

  it("uses a blurred pillarbox for 16:9 and warns the short master is below the recommended length", () => {
    const spec = registry.getAdapter("youtube_video").buildRenderSpec(master);
    expect(spec.reframe.mode).toBe("BLUR_PAD");
    expect(spec.warnings).toEqual([
      { code: "OUTSIDE_RECOMMENDED_DURATION", durationSec: 30, min: 180, max: 900 },
    ]);
  });

  it("scales when only the resolution differs", () => {
    const spec = registry.getAdapter("tiktok").buildRenderSpec({ ...master, width: 720, height: 1280 });
    expect(spec.reframe.mode).toBe("SCALE");
  });

  it("drops OPTIONAL scenes from the end before truncating", () => {
    registry.setOverride("facebook_reels", {
      video: { maxDurationSec: 22, recommendedDurationSec: { min: 10, max: 20 } },
    });
    const spec = registry.getAdapter("facebook_reels").buildRenderSpec(master);
    expect(spec.includedScenes).toEqual([1, 2, 4, 6]);
    expect(spec.durationSec).toBe(19);
    expect(spec.warnings).toEqual([{ code: "OPTIONAL_SCENES_DROPPED", scenes: [3, 5] }]);

    registry.setOverride("facebook_reels", {
      video: { maxDurationSec: 15, recommendedDurationSec: { min: 10, max: 15 } },
    });
    const truncated = registry.getAdapter("facebook_reels").buildRenderSpec(master);
    expect(truncated.durationSec).toBe(15);
    expect(truncated.warnings).toContainEqual({ code: "TRUNCATED", fromSec: 19, toSec: 15 });
    registry.clearOverride("facebook_reels");
  });
});

describe("renderCacheKey", () => {
  const base = {
    masterAssetHashes: ["a", "b"],
    targetId: "tiktok",
    specVersion: "v1",
    overlay: { hook: "x", cta: "y" },
  };

  it("is stable regardless of key order", () => {
    expect(renderCacheKey(base)).toBe(renderCacheKey({ ...base, overlay: { cta: "y", hook: "x" } }));
  });

  it("changes when any input changes", () => {
    const key = renderCacheKey(base);
    expect(renderCacheKey({ ...base, specVersion: "v2" })).not.toBe(key);
    expect(renderCacheKey({ ...base, targetId: "instagram_reels" })).not.toBe(key);
    expect(renderCacheKey({ ...base, masterAssetHashes: ["a", "c"] })).not.toBe(key);
    expect(renderCacheKey({ ...base, overlay: { hook: "z", cta: "y" } })).not.toBe(key);
  });
});
