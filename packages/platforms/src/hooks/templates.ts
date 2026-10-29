import { z } from "zod";
import { ContentFamilySchema } from "../types";

/** 冒頭〜全体の構成要素。 */
export const HookStepSchema = z.enum([
  "QUESTION",
  "PROBLEM",
  "SURPRISING_FACT",
  "RESULT_FIRST",
  "LIST_TEASER",
  "CONCLUSION",
  "REASON",
  "EXAMPLE",
  "PROCESS",
  "METHOD",
  "LIST_ITEM",
  "SUMMARY",
  "CTA",
]);
export type HookStep = z.infer<typeof HookStepSchema>;

export const HookTemplateSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1),
  steps: z.array(HookStepSchema).min(2),
  suitableFamilies: z.array(ContentFamilySchema).min(1),
  /** Claude に渡す作り方の指示。 */
  promptGuidance: z.string().min(1),
});
export type HookTemplate = z.infer<typeof HookTemplateSchema>;

/** 既定のフックテンプレート。追加はこの配列に要素を足すだけ。 */
export const builtinHookTemplates: HookTemplate[] = [
  {
    id: "problem_fact_conclusion",
    name: "問題提起型",
    steps: ["PROBLEM", "SURPRISING_FACT", "CONCLUSION", "REASON", "CTA"],
    suitableFamilies: ["SHORT_VERTICAL", "FEED", "LONG_HORIZONTAL"],
    promptGuidance: "最初の1文で視聴者が抱える悩みを言い当て、直後に意外な事実で興味を引く。",
  },
  {
    id: "question_loss",
    name: "損失回避の質問型",
    steps: ["QUESTION", "CONCLUSION", "REASON", "CTA"],
    suitableFamilies: ["SHORT_VERTICAL", "FEED"],
    promptGuidance: "「知らないと損」型の問いかけで始める。煽りすぎや断定的な誇張は避ける。",
  },
  {
    id: "shock_fact",
    name: "衝撃事実型",
    steps: ["SURPRISING_FACT", "REASON", "EXAMPLE", "CTA"],
    suitableFamilies: ["SHORT_VERTICAL", "FEED"],
    promptGuidance: "根拠のある意外な数字や事実を冒頭に置く。出典が曖昧な数字は使わない。",
  },
  {
    id: "conclusion_first",
    name: "結論先出し型",
    steps: ["CONCLUSION", "REASON", "REASON", "REASON", "SUMMARY", "CTA"],
    suitableFamilies: ["SHORT_VERTICAL", "FEED", "LONG_HORIZONTAL"],
    promptGuidance: "最初に結論を一言で言い切り、理由を短く積み重ねる。",
  },
  {
    id: "before_after",
    name: "ビフォーアフター型",
    steps: ["RESULT_FIRST", "PROCESS", "METHOD", "CTA"],
    suitableFamilies: ["SHORT_VERTICAL", "LONG_HORIZONTAL"],
    promptGuidance: "結果（変化後）を先に見せ、そこに至る過程と方法を示す。",
  },
  {
    id: "list_teaser",
    name: "リスト予告型",
    steps: ["LIST_TEASER", "LIST_ITEM", "LIST_ITEM", "LIST_ITEM", "CTA"],
    suitableFamilies: ["SHORT_VERTICAL", "FEED", "LONG_HORIZONTAL"],
    promptGuidance: "「〇〇3選」のように数を予告し、最後まで見る理由を作る。",
  },
];

export class HookTemplateRegistry {
  private readonly templates = new Map<string, HookTemplate>();

  constructor(templates: readonly HookTemplate[] = []) {
    for (const t of templates) this.register(t);
  }

  register(template: HookTemplate): void {
    const parsed = HookTemplateSchema.parse(template);
    if (this.templates.has(parsed.id)) throw new Error(`Hook template already registered: ${parsed.id}`);
    this.templates.set(parsed.id, parsed);
  }

  has(id: string): boolean {
    return this.templates.has(id);
  }

  get(id: string): HookTemplate {
    const t = this.templates.get(id);
    if (!t) throw new Error(`Unknown hook template: ${id}`);
    return t;
  }

  list(): HookTemplate[] {
    return [...this.templates.values()];
  }

  forFamily(family: HookTemplate["suitableFamilies"][number]): HookTemplate[] {
    return this.list().filter((t) => t.suitableFamilies.includes(family));
  }
}
