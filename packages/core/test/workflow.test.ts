import { describe, expect, it } from "vitest";
import { canTransition } from "../src";

describe("canTransition", () => {
  it("allows the master → platform optimization path", () => {
    expect(canTransition("VIDEO_EDITING", "PLATFORM_OPTIMIZATION")).toBe(true);
    expect(canTransition("PLATFORM_OPTIMIZATION", "QUALITY_CHECK")).toBe(true);
    expect(canTransition("WAITING_APPROVAL", "READY_FOR_DOWNLOAD")).toBe(true);
  });

  it("never skips human approval before download or publishing", () => {
    expect(canTransition("QUALITY_CHECK", "READY_FOR_DOWNLOAD")).toBe(false);
    expect(canTransition("QUALITY_CHECK", "PUBLISHING")).toBe(false);
    expect(canTransition("PLATFORM_OPTIMIZATION", "PUBLISHING")).toBe(false);
  });

  it("resumes paused or failed work only to the state it stopped at", () => {
    expect(canTransition("VIDEO_GENERATION", "PAUSED")).toBe(true);
    expect(canTransition("PAUSED", "VIDEO_GENERATION", "VIDEO_GENERATION")).toBe(true);
    expect(canTransition("PAUSED", "PUBLISHING", "VIDEO_GENERATION")).toBe(false);
    expect(canTransition("FAILED", "VIDEO_GENERATION")).toBe(false);
  });

  it("treats rejected and cancelled as terminal", () => {
    expect(canTransition("REJECTED", "REVISING")).toBe(false);
    expect(canTransition("CANCELLED", "PAUSED")).toBe(false);
  });
});
