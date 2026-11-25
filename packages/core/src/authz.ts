/**
 * チャンネル内のロールと権限（docs/security.md「認可」）。
 * ロールは単純な上下関係ではない（APPROVER は承認できるが設定は変えられない）ので、権限の集合で表す。
 */
export const CHANNEL_ROLES = ["OWNER", "EDITOR", "APPROVER", "VIEWER"] as const;
export type ChannelRole = (typeof CHANNEL_ROLES)[number];

export const PERMISSIONS = [
  /** 閲覧（ダッシュボード・企画・台本・コスト） */
  "channel:read",
  /** 制作条件の変更・市場分析の開始・企画選択・修正指示 */
  "channel:edit",
  /** 承認・却下・再生成 */
  "approval:decide",
  /** 予算・自動投稿・SNS 連携・メンバー管理・SNS 仕様の上書き */
  "channel:admin",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Readonly<Record<ChannelRole, readonly Permission[]>> = {
  OWNER: PERMISSIONS,
  EDITOR: ["channel:read", "channel:edit"],
  APPROVER: ["channel:read", "approval:decide"],
  VIEWER: ["channel:read"],
};

export function hasPermission(role: ChannelRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsOf(role: ChannelRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}
