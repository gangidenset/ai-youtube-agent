import type { CSSProperties } from "react";

// 最小限のスタイル（UI ライブラリは画面が増える Issue で導入する）。スマホ幅（375px）で崩れないことを優先する
export const styles = {
  card: {
    maxWidth: 420,
    margin: "48px auto",
    padding: 24,
    border: "1px solid #d0d7de",
    borderRadius: 12,
    background: "#fff",
  },
  page: { maxWidth: 720, margin: "0 auto", paddingBottom: 48 },
  section: {
    padding: 16,
    marginBottom: 16,
    border: "1px solid #d0d7de",
    borderRadius: 12,
    background: "#fff",
  },
  item: { padding: "12px 0", borderTop: "1px solid #eaeef2" },
  field: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 },
  input: { fontSize: 16, padding: "10px 12px", border: "1px solid #8c959f", borderRadius: 8 },
  button: {
    width: "100%",
    fontSize: 16,
    padding: "12px 16px",
    border: "none",
    borderRadius: 8,
    background: "#1f6feb",
    color: "#fff",
    cursor: "pointer",
  },
  secondaryButton: {
    fontSize: 15,
    padding: "10px 14px",
    border: "1px solid #1f6feb",
    borderRadius: 8,
    background: "#fff",
    color: "#1f6feb",
    cursor: "pointer",
  },
  badge: {
    display: "inline-block",
    fontSize: 12,
    padding: "2px 8px",
    borderRadius: 999,
    background: "#eaeef2",
    marginRight: 6,
  },
  muted: { color: "#57606a", fontSize: 14 },
  link: { color: "#0969da" },
  error: { color: "#cf222e", marginBottom: 16 },
} satisfies Record<string, CSSProperties>;
