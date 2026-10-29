import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server";

describe("api server", () => {
  it("responds to health checks", async () => {
    const res = await buildServer().inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("lists platform targets from the registry", async () => {
    const res = await buildServer().inject({ method: "GET", url: "/api/v1/platform-targets" });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { targets: { id: string }[] }).targets.map((t) => t.id);
    expect(ids).toEqual([
      "tiktok",
      "instagram_reels",
      "youtube_shorts",
      "youtube_video",
      "x_video",
      "facebook_reels",
    ]);
  });
});
