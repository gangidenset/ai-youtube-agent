import { hasPermission, type Permission } from "@aya/core";
import type { PrismaClient } from "@aya/db";
import type { FastifyRequest } from "fastify";
import { forbidden, unauthorized } from "../errors";
import type { AuthContext } from "./plugin";

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

/**
 * チャンネルの所属とロールを確認する（IDOR 防止）。
 * 所属していないチャンネルは存在を知られないよう 404 ではなく 403 に統一する。
 */
export async function requireChannelPermission(
  prisma: PrismaClient,
  request: FastifyRequest,
  channelId: string,
  permission: Permission,
) {
  const auth = requireAuth(request);
  const membership = await prisma.channelMember.findUnique({
    where: { channelId_userId: { channelId, userId: auth.userId } },
    include: { channel: true },
  });
  if (!membership || membership.channel.deletedAt || !hasPermission(membership.role, permission)) {
    throw forbidden();
  }
  return { auth, membership };
}
