import type { CSSProperties } from "react";

// 最小限のスタイル（UI ライブラリは画面が増える Issue で導入する）
export const styles = {
  card: {
    maxWidth: 420,
    margin: "48px auto",
    padding: 24,
    border: "1px solid #d0d7de",
    borderRadius: 12,
    background: "#fff",
  },
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
  error: { color: "#cf222e", marginBottom: 16 },
} satisfies Record<string, CSSProperties>;
