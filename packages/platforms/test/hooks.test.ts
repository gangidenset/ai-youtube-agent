import { describe, expect, it } from "vitest";
import { builtinHookTemplates, createDefaultRegistry, HookTemplateRegistry } from "../src";

describe("hook templates", () => {
  it("has six builtin templates, all ending with a CTA", () => {
    expect(builtinHookTemplates).toHaveLength(6);
    for (const t of builtinHookTemplates) expect(t.steps.at(-1)).toBe("CTA");
  });

  it("can be extended by registering a new template", () => {
    const registry = new HookTemplateRegistry(builtinHookTemplates);
    registry.register({
      id: "myth_buster",
      name: "常識破り型",
      steps: ["SURPRISING_FACT", "REASON", "CTA"],
      suitableFamilies: ["SHORT_VERTICAL"],
      promptGuidance: "よくある思い込みを否定してから理由を示す。",
    });
    expect(registry.forFamily("SHORT_VERTICAL").map((t) => t.id)).toContain("myth_buster");
    expect(() => registry.register(builtinHookTemplates[0]!)).toThrow(/already registered/);
  });

  it("every target's preferred templates exist and suit its content family", () => {
    const registry = createDefaultRegistry();
    for (const config of registry.list()) {
      for (const id of config.style.preferredHookTemplates) {
        expect(registry.hookTemplates.get(id).suitableFamilies).toContain(config.contentFamily);
      }
    }
  });
});
