"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, api, newIdempotencyKey, type ResearchRunSummary } from "../../../lib/api";
import { canEdit, useSession } from "../../../lib/session";
import { STATE_LABEL } from "../../labels";
import { styles } from "../../styles";

export default function ChannelPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const session = useSession();
  const [runs, setRuns] = useState<ResearchRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 同じ送信を二重に押しても市場分析が 2 回始まらないよう、フォームごとにキーを固定する
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const load = useCallback(() => {
    api.listResearchRuns(id).then(
      (r) => setRuns(r.researchRuns),
      (err: unknown) => setError(err instanceof ApiError ? err.message : "読み込みに失敗しました"),
    );
  }, [id]);
  useEffect(load, [load]);

  if (!session) return <main style={styles.card}>読み込み中…</main>;
  const channel = session.user.channels.find((c) => c.id === id);
  const editable = canEdit(session, id);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    const raw = String(new FormData(event.currentTarget).get("keywords") ?? "");
    const keywords = raw
      .split(/[,、\n]/)
      .map((k) => k.trim())
      .filter(Boolean);
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.startResearchRun(id, keywords, session.csrfToken, idempotencyKey);
      setIdempotencyKey(newIdempotencyKey());
      router.push(`/research-runs/${res.researchRunId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "開始できませんでした");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={styles.page}>
      <p>
        <Link href="/" style={styles.link}>
          ← ホーム
        </Link>
      </p>
      <h1 style={{ fontSize: 22 }}>{channel?.name ?? "チャンネル"}</h1>

      {editable && (
        <section style={styles.section}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>市場分析を開始</h2>
          <form onSubmit={start}>
            <label style={styles.field}>
              キーワード（任意・カンマ区切り、最大 5 個。空ならチャンネル設定のジャンルを使います）
              <input style={styles.input} name="keywords" placeholder="例: AI副業, ChatGPT 活用" />
            </label>
            {error && (
              <p role="alert" style={styles.error}>
                {error}
              </p>
            )}
            <button style={styles.button} type="submit" disabled={submitting}>
              {submitting ? "開始しています…" : "市場分析を開始"}
            </button>
          </form>
          <p style={styles.muted}>
            YouTube の公開データを集めて傾向を分析します。結果は目安で、再生数を保証するものではありません。
          </p>
        </section>
      )}

      <section style={styles.section}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>これまでの市場分析</h2>
        {runs === null ? (
          <p>読み込み中…</p>
        ) : runs.length === 0 ? (
          <p>まだありません。</p>
        ) : (
          runs.map((r) => (
            <div key={r.id} style={styles.item}>
              <Link href={`/research-runs/${r.id}`} style={styles.link}>
                {r.keywords.join("、")}
              </Link>
              <div style={styles.muted}>
                {new Date(r.createdAt).toLocaleString("ja-JP")}・{STATE_LABEL[r.state] ?? r.state}
              </div>
            </div>
          ))
        )}
      </section>
    </main>
  );
}
