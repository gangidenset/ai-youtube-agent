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

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface ResearchRunSummary {
  id: string;
  state: string;
  keywords: string[];
  createdAt: string;
  completedAt: string | null;
}

export interface ResearchRunDetail extends ResearchRunSummary {
  channelId: string;
  region: string;
  quotaUsed: number;
  jobs: {
    id: string;
    jobType: string;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
  }[];
  competitorVideos: { total: number; shortsEstimated: number };
}

export interface TrendItem {
  id: string;
  topic: string;
  trendType: string;
  trendScore: number;
  uncertainty: string | null;
  competitionLevel: RiskLevel | null;
  risks: unknown;
}

export interface IdeaItem {
  id: string;
  label: string;
  status: "PROPOSED" | "SELECTED" | "DISCARDED";
  title: string;
  theme: string;
  target: string;
  hook: string;
  story: string;
  durationSec: number;
  sceneCount: number;
  cta: string;
  trendScore: number;
  originalityScore: number;
  copyRisk: RiskLevel;
  policyRisk: RiskLevel;
  risks: unknown;
  autoSelectable: boolean;
  notAutoSelectableReason: string | null;
}

export interface IdeasResponse {
  state: string;
  selectionMode: "AUTO_TOP" | "MANUAL";
  canSelect: boolean;
  project: { id: string; code: string; state: string; ideaId: string | null } | null;
  notice: string;
  ideas: IdeaItem[];
}

/** ジョブを起動する POST に付ける、送信ごとに変わらないキー（二重送信しても 1 回だけ実行される） */
export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

export const api = {
  login: (email: string, password: string) =>
    request<SessionResponse>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<SessionResponse>("/api/v1/auth/me"),
  logout: (csrfToken: string) => request<void>("/api/v1/auth/logout", { method: "POST", csrfToken }),
  listResearchRuns: (channelId: string) =>
    request<{ researchRuns: ResearchRunSummary[] }>(`/api/v1/channels/${channelId}/research-runs`),
  startResearchRun: (
    channelId: string,
    keywords: string[] | undefined,
    csrfToken: string,
    idempotencyKey: string,
  ) =>
    request<{ researchRunId: string; jobId: string }>(`/api/v1/channels/${channelId}/research-runs`, {
      method: "POST",
      csrfToken,
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(keywords && keywords.length > 0 ? { keywords } : {}),
    }),
  getResearchRun: (id: string) => request<ResearchRunDetail>(`/api/v1/research-runs/${id}`),
  getTrends: (id: string) =>
    request<{ notice: string; trends: TrendItem[] }>(`/api/v1/research-runs/${id}/trends`),
  getIdeas: (id: string) => request<IdeasResponse>(`/api/v1/research-runs/${id}/ideas`),
  selectIdea: (ideaId: string, csrfToken: string) =>
    request<{ projectId: string; projectCode: string; swapped: boolean }>(`/api/v1/ideas/${ideaId}/select`, {
      method: "POST",
      csrfToken,
    }),
};
