"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  api,
  type IdeaItem,
  type IdeasResponse,
  type ResearchRunDetail,
  type TrendItem,
} from "../../../lib/api";
import { canEdit, useSession } from "../../../lib/session";
import { IN_PROGRESS_STATES, RISK_LABEL, STATE_LABEL } from "../../labels";
import { styles } from "../../styles";

const POLL_MS = 3000;

export default function ResearchRunPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const [run, setRun] = useState<ResearchRunDetail | null>(null);
  const [trends, setTrends] = useState<{ notice: string; trends: TrendItem[] } | null>(null);
  const [ideas, setIdeas] = useState<IdeasResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyIdea, setBusyIdea] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, t, i] = await Promise.all([api.getResearchRun(id), api.getTrends(id), api.getIdeas(id)]);
      setRun(r);
      setTrends(t);
      setIdeas(i);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "読み込みに失敗しました");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // 処理中は自動で更新する
  useEffect(() => {
    if (!run || !IN_PROGRESS_STATES.has(run.state)) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [run, load]);

  if (!session || (!run && !error)) return <main style={styles.card}>読み込み中…</main>;
  if (!run) return <main style={styles.card}>{error}</main>;

  const editable = canEdit(session, run.channelId);
  const failedJob = run.jobs.find((j) => j.status === "FAILED");

  async function select(idea: IdeaItem) {
    if (!session) return;
    setBusyIdea(idea.id);
    setError(null);
    try {
      await api.selectIdea(idea.id, session.csrfToken);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "選択できませんでした");
    } finally {
      setBusyIdea(null);
    }
  }

  return (
    <main style={styles.page}>
      <p>
        <Link href={`/channels/${run.channelId}`} style={styles.link}>
          ← チャンネル
        </Link>
      </p>
      <h1 style={{ fontSize: 22 }}>市場分析: {run.keywords.join("、")}</h1>
      <p>
        <span style={styles.badge}>{STATE_LABEL[run.state] ?? run.state}</span>
        <span style={styles.muted}>
          収集 {run.competitorVideos.total} 本（Shorts 推定 {run.competitorVideos.shortsEstimated}{" "}
          本）・クォータ {run.quotaUsed} units
        </span>
      </p>
      {IN_PROGRESS_STATES.has(run.state) && (
        <p style={styles.muted}>処理中です。この画面は自動で更新されます。</p>
      )}
      {failedJob && (
        <p role="alert" style={styles.error}>
          処理に失敗しました（{failedJob.jobType}）: {failedJob.errorMessage ?? failedJob.errorCode}
        </p>
      )}
      {error && (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      )}

      {trends && trends.trends.length > 0 && (
        <section style={styles.section}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>トレンド</h2>
          <p style={styles.muted}>{trends.notice}</p>
          {trends.trends.map((t) => (
            <div key={t.id} style={styles.item}>
              <strong>{t.topic}</strong>
              <div>
                <span style={styles.badge}>Trend Score {t.trendScore}</span>
                {t.competitionLevel && (
                  <span style={styles.badge}>競合 {RISK_LABEL[t.competitionLevel]}</span>
                )}
              </div>
              {t.uncertainty && <div style={styles.muted}>不確実性: {t.uncertainty}</div>}
            </div>
          ))}
        </section>
      )}

      {ideas && ideas.ideas.length > 0 && (
        <section style={styles.section}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>企画</h2>
          <p style={styles.muted}>
            {ideas.selectionMode === "AUTO_TOP" ? "自動採用モード" : "手動選択モード"}・{ideas.notice}
          </p>
          {ideas.project && (
            <p>
              採用中: <strong>{ideas.project.code}</strong>（
              {STATE_LABEL[ideas.project.state] ?? ideas.project.state}）
            </p>
          )}
          {ideas.ideas.map((idea) => (
            <article key={idea.id} style={styles.item}>
              <div>
                <span style={styles.badge}>{idea.label} 案</span>
                {idea.status === "SELECTED" && (
                  <span style={{ ...styles.badge, background: "#dafbe1" }}>採用中</span>
                )}
              </div>
              <h3 style={{ fontSize: 16, margin: "6px 0" }}>{idea.title}</h3>
              <div>
                <span style={styles.badge}>Trend {idea.trendScore}</span>
                <span style={styles.badge}>Originality {idea.originalityScore}</span>
                <span style={styles.badge}>コピーリスク {RISK_LABEL[idea.copyRisk]}</span>
                <span style={styles.badge}>ポリシーリスク {RISK_LABEL[idea.policyRisk]}</span>
              </div>
              <p style={{ margin: "8px 0" }}>フック: {idea.hook}</p>
              <p style={styles.muted}>
                対象: {idea.target}・{idea.durationSec} 秒・{idea.sceneCount} シーン・CTA: {idea.cta}
              </p>
              <p style={styles.muted}>{idea.story}</p>
              {!idea.autoSelectable && (
                <p style={{ ...styles.muted, color: "#9a6700" }}>
                  自動採用の対象外: {idea.notAutoSelectableReason}
                </p>
              )}
              {editable && ideas.canSelect && idea.status !== "SELECTED" && (
                <button
                  type="button"
                  style={styles.secondaryButton}
                  disabled={busyIdea !== null}
                  onClick={() => void select(idea)}
                >
                  {busyIdea === idea.id
                    ? "処理中…"
                    : ideas.project
                      ? "この案に差し替える"
                      : "この案を採用する"}
                </button>
              )}
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
