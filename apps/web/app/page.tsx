"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { styles } from "./styles";

const ROLE_LABEL = { OWNER: "オーナー", EDITOR: "編集者", APPROVER: "承認者", VIEWER: "閲覧者" } as const;

export default function HomePage() {
  const router = useRouter();
  const session = useSession();
  if (!session) return <main style={styles.card}>読み込み中…</main>;

  async function logout() {
    if (!session) return;
    await api.logout(session.csrfToken).catch(() => undefined);
    router.replace("/login");
  }

  return (
    <main style={styles.page}>
      <h1>AI YouTube Agent</h1>
      <p style={styles.muted}>{session.user.displayName} さんでログイン中</p>
      <section style={styles.section}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>チャンネル</h2>
        {session.user.channels.length === 0 ? (
          <p>所属しているチャンネルはありません。</p>
        ) : (
          session.user.channels.map((c) => (
            <div key={c.id} style={styles.item}>
              <Link href={`/channels/${c.id}`} style={styles.link}>
                {c.name}
              </Link>
              <span style={{ ...styles.muted, marginLeft: 8 }}>（{ROLE_LABEL[c.role]}）</span>
            </div>
          ))
        )}
      </section>
      <button style={{ ...styles.button, background: "#57606a" }} type="button" onClick={logout}>
        ログアウト
      </button>
    </main>
  );
}
