import type { Chapter, PostText, TargetMetadata, ValidationIssue } from "../types";
import { DefaultPlatformAdapter } from "./default-adapter";

/** チャプターの最小件数と最短間隔（YouTube の自動チャプター条件に準拠）。 */
export const MIN_CHAPTERS = 3;
export const MIN_CHAPTER_GAP_SEC = 10;

export function formatTimestamp(sec: number): string {
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function chapterProblem(chapters: readonly Chapter[]): string | null {
  if (chapters.length < MIN_CHAPTERS) return `チャプターは${MIN_CHAPTERS}件以上必要です`;
  if (chapters[0]?.startSec !== 0) return "最初のチャプターは 0 秒から始めてください";
  for (let i = 1; i < chapters.length; i++) {
    const prev = chapters[i - 1];
    const cur = chapters[i];
    if (prev && cur && cur.startSec - prev.startSec < MIN_CHAPTER_GAP_SEC) {
      return `チャプターの間隔は${MIN_CHAPTER_GAP_SEC}秒以上にしてください`;
    }
  }
  return null;
}

/**
 * 説明文にチャプター（タイムスタンプ一覧）を載せる SNS 向けの Adapter。
 * 長尺の横動画など、features.chapters が true の Target で使う。
 */
export class ChaptersAdapter extends DefaultPlatformAdapter {
  override validateMetadata(metadata: TargetMetadata): ValidationIssue[] {
    const issues = super.validateMetadata(metadata);
    if (metadata.chapters && metadata.chapters.length > 0) {
      const problem = chapterProblem(metadata.chapters);
      if (problem) issues.push({ field: "chapters", code: "INVALID_CHAPTERS", message: problem });
    }
    // チャプター一覧を足した説明文の長さは、親クラスの投稿文チェック（formatPostText 経由）で検証される
    return issues;
  }

  override formatPostText(metadata: TargetMetadata): PostText {
    const chapters = metadata.chapters ?? [];
    if (chapters.length === 0 || chapterProblem(chapters)) return super.formatPostText(metadata);
    const list = chapters.map((c) => `${formatTimestamp(c.startSec)} ${c.title}`).join("\n");
    const description = [metadata.description, list].filter(Boolean).join("\n\n");
    return super.formatPostText({ ...metadata, description });
  }
}
