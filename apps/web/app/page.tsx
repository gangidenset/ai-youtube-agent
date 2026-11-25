"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, api, type SessionResponse } from "../lib/api";
import { styles } from "./styles";

const ROLE_LABEL = { OWNER: "オーナー", EDITOR: "編集者", APPROVER: "承認者", VIEWER: "閲覧者" } as const;

export default function HomePage() {
  const router = useRouter();
  const [session, setSession] = useState<SessionResponse | null>(null);

  useEffect(() => {
    api.me().then(setSession, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) router.replace("/login");
    });
  }, [router]);

  if (!session) return <main style={styles.card}>読み込み中…</main>;

  async function logout() {
    if (!session) return;
    await api.logout(session.csrfToken).catch(() => undefined);
    router.replace("/login");
  }

  return (
    <main style={styles.card}>
      <h1 style={{ marginTop: 0 }}>AI YouTube Agent</h1>
      <p>{session.user.displayName} さんでログイン中</p>
      <h2 style={{ fontSize: 18 }}>チャンネル</h2>
      {session.user.channels.length === 0 ? (
        <p>所属しているチャンネルはありません。</p>
      ) : (
        <ul>
          {session.user.channels.map((c) => (
            <li key={c.id}>
              {c.name}（{ROLE_LABEL[c.role]}）
            </li>
          ))}
        </ul>
      )}
      <p style={{ color: "#57606a" }}>ダッシュボードと動画生成の画面は今後の Issue で追加します。</p>
      <button style={{ ...styles.button, background: "#57606a" }} type="button" onClick={logout}>
        ログアウト
      </button>
    </main>
  );
}
