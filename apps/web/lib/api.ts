// ブラウザから API を呼ぶ薄いクライアント。/api/* は Next の rewrite で API サーバへ転送される（同一オリジン）。
// Secret は扱わない。認証は httpOnly Cookie、状態を変えるリクエストには CSRF トークンを付ける。

export interface ChannelSummary {
  id: string;
  name: string;
  role: "OWNER" | "EDITOR" | "APPROVER" | "VIEWER";
  permissions: string[];
}

export interface Profile {
  id: string;
  email: string;
  displayName: string;
  channels: ChannelSummary[];
}

export interface SessionResponse {
  user: Profile;
  csrfToken: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { csrfToken?: string } = {}): Promise<T> {
  const { csrfToken, headers, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    credentials: "same-origin",
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...headers,
    },
  });
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, error?.code ?? "UNKNOWN", error?.message ?? "エラーが発生しました");
  }
  return body as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<SessionResponse>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<SessionResponse>("/api/v1/auth/me"),
  logout: (csrfToken: string) => request<void>("/api/v1/auth/logout", { method: "POST", csrfToken }),
};
