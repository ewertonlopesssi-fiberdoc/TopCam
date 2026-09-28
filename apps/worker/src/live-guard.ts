import { PLATFORM, liveAccessAllowed, withScope } from "@topcam/db";
import { GRANTED_VISIBILITY_ROLES, verifyLiveToken } from "@topcam/shared";
import type { WorkerContext } from "./context.js";

/**
 * Guarda das sessões WebRTC do ao vivo.
 *
 * No HLS, cada pedido passa pelo gateway, que reconfere o acesso. No WebRTC, só a
 * negociação (WHEP) passa por ele: depois, a mídia vai direto do MediaMTX ao
 * navegador. Por isso, a cada LIVE_GUARD_INTERVAL_S, o worker confere as sessões
 * WebRTC abertas pelo token que a oferta levou na query (t=) e encerra as que não
 * valem mais (logout, usuário ou cliente desativado, permissão ou câmera retirada).
 * Sessões sem token válido também são encerradas: só o gateway abre sessões.
 */
export async function guardLiveSessions(
  ctx: WorkerContext,
): Promise<{ checked: number; kicked: number }> {
  const sessions = await ctx.mediamtx.listWebrtcSessions();
  let kicked = 0;
  const cache = new Map<string, boolean>();
  for (const s of sessions) {
    const token = new URLSearchParams(s.query ?? "").get("t") ?? "";
    let ok = false;
    let reason = "no_token";
    const v = token ? verifyLiveToken(ctx.env.JWT_SECRET, token, 0) : null;
    if (v?.ok) {
      const { claims } = v;
      const key = `${claims.u}:${claims.s}:${claims.c}`;
      if (!cache.has(key))
        cache.set(
          key,
          await withScope(ctx.pool, PLATFORM, (c) =>
            liveAccessAllowed(c, {
              userId: claims.u,
              sessionId: claims.s,
              cameraId: claims.c,
              grantedRoles: GRANTED_VISIBILITY_ROLES,
            }),
          ),
        );
      // A sessão tem de ser da câmera do token.
      ok = cache.get(key)! && s.path === `cam/${claims.c}`;
      reason = ok ? "" : "revoked";
    } else if (v) {
      reason = v.reason;
    }
    if (!ok) {
      await ctx.mediamtx.kickWebrtcSession(s.id).catch(() => undefined);
      kicked++;
      ctx.log.info({ session: s.id, path: s.path, reason }, "sessão WebRTC do ao vivo encerrada");
    }
  }
  return { checked: sessions.length, kicked };
}
