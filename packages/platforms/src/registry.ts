import { DefaultPlatformAdapter } from "./adapters/default-adapter";
import { builtinHookTemplates, HookTemplateRegistry } from "./hooks/templates";
import { builtinTargets } from "./targets";
import {
  type AdapterFactory,
  type PlatformAdapter,
  type PlatformTargetConfig,
  PlatformTargetConfigSchema,
  type PlatformTargetDefinition,
} from "./types";

/** 実行時の上書き（DB の platform_config_overrides から読み込む）。配列は置き換え、オブジェクトは再帰的にマージする。 */
export type ConfigPatch = { [key: string]: unknown };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, patch: ConfigPatch): T {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result as T;
}

interface Entry {
  base: PlatformTargetConfig;
  createAdapter: AdapterFactory;
}

const defaultFactory: AdapterFactory = (config) => new DefaultPlatformAdapter(config);

/**
 * 出力先（Target）の登録簿。ワークフロー・API・UI・プロンプトはここから一覧を取得するので、
 * SNS を追加しても他のコードを修正する必要はない。
 */
export class PlatformRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly overrides = new Map<string, ConfigPatch>();

  constructor(
    readonly hookTemplates: HookTemplateRegistry = new HookTemplateRegistry(builtinHookTemplates),
  ) {}

  register(definition: PlatformTargetDefinition): void {
    const config = this.validate(definition.config);
    if (this.entries.has(config.id)) throw new Error(`Platform target already registered: ${config.id}`);
    this.entries.set(config.id, { base: config, createAdapter: definition.createAdapter ?? defaultFactory });
  }

  /** 上書きを設定する。マージ後に検証し、不正なら例外（上書きは保存されない）。 */
  setOverride(targetId: string, patch: ConfigPatch): PlatformTargetConfig {
    const entry = this.entry(targetId);
    if ("id" in patch && patch.id !== targetId) throw new Error("Override cannot change target id");
    const merged = this.validate(deepMerge(entry.base, patch));
    this.overrides.set(targetId, patch);
    return merged;
  }

  clearOverride(targetId: string): void {
    this.overrides.delete(targetId);
  }

  has(targetId: string): boolean {
    return this.entries.has(targetId);
  }

  getConfig(targetId: string): PlatformTargetConfig {
    const entry = this.entry(targetId);
    const patch = this.overrides.get(targetId);
    return patch ? this.validate(deepMerge(entry.base, patch)) : entry.base;
  }

  getAdapter(targetId: string): PlatformAdapter {
    return this.entry(targetId).createAdapter(this.getConfig(targetId));
  }

  list(): PlatformTargetConfig[] {
    return [...this.entries.keys()].map((id) => this.getConfig(id));
  }

  /** 登録済み Target が属する SNS の一覧（重複なし）。 */
  listPlatforms(): string[] {
    return [...new Set(this.list().map((c) => c.platform))];
  }

  /** ユーザーが選んだ出力先 ID を検証し、重複を除いて返す。 */
  resolveSelection(targetIds: readonly string[]): PlatformTargetConfig[] {
    if (targetIds.length === 0) throw new Error("At least one target must be selected");
    const unknown = targetIds.filter((id) => !this.has(id));
    if (unknown.length > 0) throw new Error(`Unknown platform targets: ${unknown.join(", ")}`);
    return [...new Set(targetIds)].map((id) => this.getConfig(id));
  }

  private entry(targetId: string): Entry {
    const entry = this.entries.get(targetId);
    if (!entry) throw new Error(`Unknown platform target: ${targetId}`);
    return entry;
  }

  private validate(input: unknown): PlatformTargetConfig {
    const config = PlatformTargetConfigSchema.parse(input);
    const missing = config.style.preferredHookTemplates.filter((id) => !this.hookTemplates.has(id));
    if (missing.length > 0) {
      throw new Error(`${config.id}: unknown hook templates: ${missing.join(", ")}`);
    }
    return config;
  }
}

/** 組み込み Target とフックテンプレートを登録済みの Registry を作る。 */
export function createDefaultRegistry(): PlatformRegistry {
  const registry = new PlatformRegistry();
  for (const definition of builtinTargets) registry.register(definition);
  return registry;
}
