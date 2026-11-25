"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, api, type SessionResponse } from "./api";

/** ログイン中のユーザーと CSRF トークン。未ログインならログイン画面へ移動する。 */
export function useSession(): SessionResponse | null {
  const router = useRouter();
  const [session, setSession] = useState<SessionResponse | null>(null);
  useEffect(() => {
    api.me().then(setSession, (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) router.replace("/login");
    });
  }, [router]);
  return session;
}

export function canEdit(session: SessionResponse, channelId: string): boolean {
  return session.user.channels.some((c) => c.id === channelId && c.permissions.includes("channel:edit"));
}
