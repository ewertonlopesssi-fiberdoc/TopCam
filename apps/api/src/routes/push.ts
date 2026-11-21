import { PLATFORM, withScope } from "@topcam/db";
import { isExpoPushToken, sendPush } from "@topcam/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { HttpError, parseBody } from "../lib/http.js";

/**
 * Celulares que recebem os alarmes por push (app, Fase 9.3).
 * O app registra o token a cada abertura (ligado ao usuário e à sessão atual). Desligar as
 * notificações no app grava enabled = false; sair do app encerra a sessão, e sessão
 * encerrada não recebe push. Cada um mexe só nos próprios celulares.
 */
const deviceBody = z.object({
  token: z.string().refine(isExpoPushToken, "Token de push inválido"),
  platform: z.enum(["android", "ios"]),
  brand: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .default("topcam"),
  deviceName: z.string().max(100).optional(),
  appVersion: z.string().max(30).optional(),
  enabled: z.boolean().default(true),
});
const tokenBody = z.object({ token: z.string().refine(isExpoPushToken, "Token de push inválido") });

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  const { pool, env } = app.deps;
  const auth = { preHandler: app.authenticate };

  app.post("/api/v1/push/devices", auth, async (req) => {
    const b = parseBody(deviceBody, req.body);
    const u = req.user!;
    // Escopo de plataforma: o mesmo celular pode ter sido de outro usuário (trocou de conta).
    const r = await withScope(pool, PLATFORM, async (c) => {
      const prev = (
        await c.query<{ user_id: string; enabled: boolean }>(
          "SELECT user_id, enabled FROM push_devices WHERE token = $1",
          [b.token],
        )
      ).rows[0];
      await c.query(
        `INSERT INTO push_devices (user_id, tenant_id, session_id, token, platform, brand, device_name, app_version, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (token) DO UPDATE SET
           user_id = EXCLUDED.user_id, tenant_id = EXCLUDED.tenant_id, session_id = EXCLUDED.session_id,
           platform = EXCLUDED.platform, brand = EXCLUDED.brand, device_name = EXCLUDED.device_name,
           app_version = EXCLUDED.app_version, enabled = EXCLUDED.enabled,
           disabled_reason = CASE WHEN EXCLUDED.enabled THEN NULL ELSE 'usuario' END,
           updated_at = now()`,
        [
          u.id,
          u.tenantId,
          u.sessionId,
          b.token,
          b.platform,
          b.brand,
          b.deviceName ?? null,
          b.appVersion ?? null,
          b.enabled,
        ],
      );
      if (!prev || prev.user_id !== u.id || prev.enabled !== b.enabled)
        await audit(c, req, b.enabled ? "push.device_enabled" : "push.device_disabled", {
          entityType: "user",
          entityId: u.id,
          data: { platform: b.platform, brand: b.brand, device: b.deviceName ?? null },
        });
      return { enabled: b.enabled };
    });
    return { ok: true, ...r };
  });

  app.delete("/api/v1/push/devices", auth, async (req) => {
    const b = parseBody(tokenBody, req.body);
    const n = await withScope(pool, PLATFORM, async (c) => {
      const d = await c.query("DELETE FROM push_devices WHERE token = $1 AND user_id = $2", [
        b.token,
        req.user!.id,
      ]);
      if (d.rowCount)
        await audit(c, req, "push.device_removed", { entityType: "user", entityId: req.user!.id });
      return d.rowCount ?? 0;
    });
    return { ok: true, removed: n };
  });

  // Notificação de teste para os celulares do próprio usuário (sessões ativas).
  const testLimit = { preHandler: [app.authenticate, app.rateLimit("push-test", 5, 300)] };
  app.post("/api/v1/push/test", testLimit, async (req) => {
    const u = req.user!;
    const devices = await withScope(
      pool,
      PLATFORM,
      async (c) =>
        (
          await c.query<{ id: string; token: string }>(
            `SELECT d.id::text, d.token FROM push_devices d
               JOIN sessions s ON s.id = d.session_id AND s.revoked_at IS NULL AND s.expires_at > now()
              WHERE d.user_id = $1 AND d.enabled
              ORDER BY d.updated_at DESC LIMIT 10`,
            [u.id],
          )
        ).rows,
    );
    if (!devices.length)
      throw new HttpError(
        404,
        "no_devices",
        "Nenhum celular com as notificações ligadas nesta conta.",
      );
    const tickets = await sendPush(
      devices.map((d) => ({
        to: d.token,
        title: "TopCam: notificação de teste",
        body: "Se você está vendo isto, os alarmes vão chegar neste celular.",
        sound: "default",
        priority: "high",
        channelId: "alarmes",
        ttl: 600,
        data: { type: "test" },
      })),
      { url: env.EXPO_PUSH_URL, accessToken: env.EXPO_ACCESS_TOKEN },
    );
    const errors = tickets
      .filter((t) => t.status !== "ok")
      .map((t) => `${t.error ?? ""} ${t.message ?? ""}`.trim());
    await withScope(pool, PLATFORM, (c) =>
      audit(c, req, "push.test_sent", {
        entityType: "user",
        entityId: u.id,
        data: { devices: devices.length, failed: errors.length },
      }),
    );
    return { sent: tickets.length - errors.length, failed: errors.length, errors };
  });
}
