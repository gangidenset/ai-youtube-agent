"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { ApiError, api } from "../../lib/api";
import { styles } from "../styles";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    setError(null);
    try {
      await api.login(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ログインに失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={styles.card}>
      <h1 style={{ marginTop: 0 }}>ログイン</h1>
      <form onSubmit={onSubmit} noValidate>
        <label style={styles.field}>
          メールアドレス
          <input style={styles.input} name="email" type="email" autoComplete="username" required />
        </label>
        <label style={styles.field}>
          パスワード
          <input
            style={styles.input}
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        {error && (
          <p role="alert" style={styles.error}>
            {error}
          </p>
        )}
        <button style={styles.button} type="submit" disabled={submitting}>
          {submitting ? "ログイン中…" : "ログイン"}
        </button>
      </form>
    </main>
  );
}
