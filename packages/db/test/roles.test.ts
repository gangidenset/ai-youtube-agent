import { CHANNEL_ROLES } from "@aya/core";
import { describe, expect, it } from "vitest";
import { ChannelRole } from "../src";

describe("ChannelRole enum", () => {
  it("matches packages/core", () => {
    expect(Object.values(ChannelRole)).toEqual([...CHANNEL_ROLES]);
  });
});
