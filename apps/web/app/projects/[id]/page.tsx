"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  ApiError,
  api,
  newIdempotencyKey,
  type ProjectDetail,
  type RevisionItem,
  type RevisionScope,
  type ScriptDiff,
} from "../../../lib/api";
import { useSession } from "../../../lib/session";
import { FIELD_LABEL, SCOPE_LABEL, STATE_LABEL } from "../../labels";
import { styles } from "../../styles";

const POLL_MS = 3000;

function DiffView({ diff }: { diff: ScriptDiff }) {
  if (diff.unchanged) return <p style={styles.muted}>変更はありません。</p>;
  const row = (label: string, before: string | number, after: string | number, key: string) => (
    <div key={key} style={{ margin: "6px 0" }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
      <div style={{ background: "#ffebe9", padding: "4px 8px", borderRadius: 6, wordBreak: "break-word" }}>
        − {String(before)}
      </div>
      <div style={{ background: "#dafbe1", padding: "4px 8px", borderRadius: 6, wordBreak: "break-word" }}>
        ＋ {String(after)}
      </div>
    </div>
  );
  return (
    <div>
      {diff.fields.map((f) => row(FIELD_LABEL[f.field] ?? f.field, f.before, f.after, f.field))}
      {diff.scenes.map((s) =>
        s.change === "CHANGED" ? (
          <div key={s.sceneNumber}>
            <div style={{ fontSize: 14, marginTop: 8 }}>シーン {s.sceneNumber}</div>
            {s.fields.map((f) =>
              row(FIELD_LABEL[f.field] ?? f.field, f.before, f.after, `${s.sceneNumber}-${f.field}`),
            )}
          </div>
        ) : (
          <p key={s.sceneNumber} style={styles.muted}>
            シーン {s.sceneNumber} を{s.change === "ADDED" ? "追加" : "削除"}しました
          </p>
        ),
      )}
    </div>
  );
}

function RevisionRow({ projectId, revision }: { projectId: string; revision: RevisionItem }) {
  const [diff, setDiff] = useState<ScriptDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changed = revision.toVersion !== null && revision.toVersion !== revision.fromVersion;

  async function toggle() {
    if (diff) return setDiff(null);
    if (revision.toVersion === null) return;
    try {
      setDiff(await api.getScriptDiff(projectId, revision.fromVersion, revision.toVersion));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "差分を読み込めませんでした");
    }
  }

  return (
    <div style={styles.item}>
      <div>「{revision.instruction}」</div>
      <div style={styles.muted}>
        {revision.requestedBy ?? "不明"}・{new Date(revision.createdAt).toLocaleString("ja-JP")}・
        {revision.summary?.requestedScope ? SCOPE_LABEL[revision.summary.requestedScope] : ""}
      </div>
      <div style={styles.muted}>
        {revision.toVersion === null
          ? "修正中…"
          : changed
            ? `版 ${revision.fromVersion} → 版 ${revision.toVersion}`
            : "変更はありませんでした"}
      </div>
      {revision.summary?.changeSummary && <p style={{ margin: "6px 0" }}>{revision.summary.changeSummary}</p>}
      {changed && (
        <button type="button" style={styles.secondaryButton} onClick={() => void toggle()}>
          {diff ? "差分を閉じる" : "差分を見る"}
        </button>
      )}
      {error && <p style={styles.error}>{error}</p>}
      {diff && <DiffView diff={diff} />}
    </div>
  );
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [scope, setScope] = useState<RevisionScope>("SCRIPT");
  const [submitting, setSubmitting] = useState(false);
  // 二重送信しても修正が 2 回走らないよう、入力ごとにキーを固定する
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const load = useCallback(async () => {
    try {
      setProject(await api.getProject(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "読み込みに失敗しました");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // 台本の作成・修正の間は自動で更新する
  const waiting = project !== null && (project.working || project.currentScriptVersion === null);
  useEffect(() => {
    if (!waiting || project?.lastError) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [waiting, project, load]);

  if (!session || (!project && !error)) return <main style={styles.card}>読み込み中…</main>;
  if (!project) return <main style={styles.card}>{error}</main>;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || instruction.trim().length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.requestRevision(
        id,
        { instruction: instruction.trim(), scope },
        session.csrfToken,
        idempotencyKey,
      );
      setInstruction("");
      setIdempotencyKey(newIdempotencyKey());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "修正を依頼できませんでした");
    } finally {
      setSubmitting(false);
    }
  }

  const script = project.script;
  return (
    <main style={styles.page}>
      <p>
        {project.researchRunId ? (
          <Link href={`/research-runs/${project.researchRunId}`} style={styles.link}>
            ← 市場分析
          </Link>
        ) : (
          <Link href={`/channels/${project.channelId}`} style={styles.link}>
            ← チャンネル
          </Link>
        )}
      </p>
      <h1 style={{ fontSize: 22 }}>
        {project.code}
        {project.idea ? `: ${project.idea.title}` : ""}
      </h1>
      <p>
        <span style={styles.badge}>
          {project.state === "SCRIPT_GENERATION" && project.currentScriptVersion !== null && !project.working
            ? "台本ができました"
            : (STATE_LABEL[project.state] ?? project.state)}
        </span>
        {project.currentScriptVersion !== null && (
          <span style={styles.muted}>台本 版 {project.currentScriptVersion}</span>
        )}
      </p>
      {waiting && !project.lastError && (
        <p style={styles.muted}>
          {project.currentScriptVersion === null ? "台本を作成中です" : "修正中です"}
          。この画面は自動で更新されます。
        </p>
      )}
      {project.lastError && (
        <p role="alert" style={styles.error}>
          処理に失敗しました（{project.lastError.jobType}）: {project.lastError.message}
        </p>
      )}
      {error && (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      )}

      {script && (
        <section style={styles.section}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>台本</h2>
          <h3 style={{ fontSize: 16, margin: "0 0 6px" }}>{script.title}</h3>
          <p style={{ margin: "6px 0" }}>フック: {script.hook}</p>
          <p style={styles.muted}>
            対象: {script.target}・{script.duration_seconds} 秒・{script.scenes.length} シーン
          </p>
          {script.scenes.map((scene) => (
            <div key={scene.scene_number} style={styles.item}>
              <div>
                <span style={styles.badge}>シーン {scene.scene_number}</span>
                <span style={styles.badge}>{scene.duration} 秒</span>
                {scene.priority === "OPTIONAL" && <span style={styles.badge}>短い SNS では省略可</span>}
              </div>
              <p style={{ margin: "6px 0", fontWeight: 600 }}>{scene.subtitle}</p>
              <p style={{ margin: "6px 0" }}>{scene.narration}</p>
              <p style={styles.muted}>映像: {scene.visual_prompt}</p>
            </div>
          ))}
          <div style={styles.item}>
            <p style={{ margin: "6px 0" }}>CTA: {script.cta}</p>
            <p style={styles.muted}>{script.description}</p>
            <p style={styles.muted}>{script.hashtags.join(" ")}</p>
          </div>
        </section>
      )}

      {project.canRevise && (
        <section style={styles.section}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>修正を依頼</h2>
          <form onSubmit={submit}>
            <label style={styles.field}>
              修正の指示（例: 冒頭をもっと強く、20 秒にして）
              <textarea
                style={{ ...styles.input, minHeight: 80 }}
                value={instruction}
                maxLength={1000}
                onChange={(e) => setInstruction(e.target.value)}
              />
            </label>
            <label style={styles.field}>
              変える範囲
              <select
                style={styles.input}
                value={scope}
                onChange={(e) => setScope(e.target.value as RevisionScope)}
              >
                {(Object.keys(SCOPE_LABEL) as RevisionScope[]).map((s) => (
                  <option key={s} value={s}>
                    {SCOPE_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <button
              style={styles.button}
              type="submit"
              disabled={submitting || instruction.trim().length === 0}
            >
              {submitting ? "依頼しています…" : "修正を依頼"}
            </button>
          </form>
          <p style={styles.muted}>企画のテーマとターゲットは変えずに直します。修正前の版は残ります。</p>
        </section>
      )}

      {project.revisions.length > 0 && (
        <section style={styles.section}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>修正の履歴</h2>
          {project.revisions.map((r) => (
            <RevisionRow key={r.id} projectId={project.id} revision={r} />
          ))}
        </section>
      )}
    </main>
  );
}
