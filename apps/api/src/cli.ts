#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  PLATFORM,
  createPool,
  findCameraByCode,
  insertAudit,
  insertCameraEvent,
  rotateStreamKey,
  withScope,
} from "@topcam/db";
import {
  decryptStreamKey,
  generateTempPassword,
  hashPassword,
  isPlatformRole,
  isRoleKey,
  parseEncryptionKey,
  streamKeyPrefix,
} from "@topcam/shared";

/**
 * CLI administrativa (as mesmas operações existem no painel a partir da Fase 2).
 *
 *   camera:list      [--tenant <slug>]
 *   camera:show-key  --tenant <slug> --code <CAM-001> [--raw]
 *   camera:rotate-key --tenant <slug> --code <CAM-001> [--raw]
 *   user:create      --email <e-mail> --name <nome> --role <papel> [--tenant <slug>]
 *   user:reset-password --email <e-mail>   (senha temporária; troca obrigatória no próximo acesso)
 *   user:disable     --email <e-mail>      (encerra as sessões)
 *   user:delete      --email <e-mail>      (exclusão lógica; some das listas, fica na auditoria)
 *
 * Os comandos de usuário servem para recuperar o acesso (ex.: único administrador
 * bloqueado) e para o script de aceite; ficam registrados na auditoria (ator "cli").
 *
 * Exemplo no Compose:
 *   docker compose exec api node apps/api/dist/cli.js camera:show-key --tenant empresa-alfa --code CAM-001
 */

const HELP = `uso:
  camera:list       [--tenant <slug>]
  camera:show-key   --tenant <slug> --code <código> [--raw]
  camera:rotate-key --tenant <slug> --code <código> [--raw]
  user:create         --email <e-mail> --name <nome> --role <papel> [--tenant <slug>]
  user:reset-password --email <e-mail>
  user:disable        --email <e-mail>
  user:delete         --email <e-mail>`;

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`variável obrigatória ausente: ${name}`);
    process.exit(2);
  }
  return v;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tenant: { type: "string" },
    code: { type: "string" },
    raw: { type: "boolean", default: false },
    email: { type: "string" },
    name: { type: "string" },
    role: { type: "string" },
  },
});

const cmd = positionals[0];
const pool = createPool(need("DATABASE_URL"), 2);
const encKey = parseEncryptionKey(need("STREAM_KEY_ENC_KEY"));
const host = process.env.PUBLIC_HOST ?? "localhost";
const port = process.env.RTMP_PUBLIC_PORT ?? "1935";

function printKey(tenant: string, code: string, key: string, raw: boolean) {
  if (raw) {
    console.log(key);
    return;
  }
  console.log(`Cliente:          ${tenant}`);
  console.log(`Câmera:           ${code}`);
  console.log(`Servidor (URL):   rtmp://${host}:${port}/live`);
  console.log(`Chave:            ${key}`);
  console.log(`URL completa:     rtmp://${host}:${port}/live/${key}`);
}

async function main() {
  if (cmd === "camera:list") {
    const rows = await withScope(
      pool,
      PLATFORM,
      async (c) =>
        (
          await c.query(
            `SELECT t.slug, c.code, c.name, c.status, c.recording_enabled, c.stream_key_prefix,
                  c.video_codec, c.width, c.height, c.fps, c.bitrate_kbps,
                  to_char(c.last_video_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI:SS') AS last_video
             FROM cameras c JOIN tenants t ON t.id = c.tenant_id
            WHERE c.deleted_at IS NULL AND ($1::text IS NULL OR t.slug = $1)
            ORDER BY t.slug, c.code`,
            [values.tenant ?? null],
          )
        ).rows,
    );
    console.table(rows);
    return;
  }

  if (cmd === "camera:show-key" || cmd === "camera:rotate-key") {
    if (!values.tenant || !values.code) {
      console.error(HELP);
      process.exit(2);
    }
    const tenant = values.tenant;
    const code = values.code;
    const key = await withScope(pool, PLATFORM, async (c) => {
      const camera = await findCameraByCode(c, tenant, code);
      if (!camera) throw new Error(`câmera ${tenant}/${code} não encontrada`);
      if (cmd === "camera:show-key") {
        if (!camera.stream_key_enc) throw new Error("câmera sem chave RTMP");
        await insertAudit(c, {
          tenantId: camera.tenant_id,
          actorType: "cli",
          action: "camera.stream_key_viewed",
          entityType: "camera",
          entityId: camera.id,
          data: { code },
        });
        return decryptStreamKey(camera.stream_key_enc, encKey);
      }
      // Gera a chave nova, encerra a sessão da chave antiga e agenda a reconciliação.
      const newKey = await rotateStreamKey(c, camera.id, encKey);
      await insertAudit(c, {
        tenantId: camera.tenant_id,
        actorType: "cli",
        action: "camera.stream_key_rotated",
        entityType: "camera",
        entityId: camera.id,
        data: { code, new_prefix: streamKeyPrefix(newKey) },
      });
      await insertCameraEvent(c, {
        tenantId: camera.tenant_id,
        cameraId: camera.id,
        type: "key_rotated",
        severity: "warning",
        message: `Chave de transmissão de ${code} foi trocada; a chave anterior deixou de valer`,
      });
      return newKey;
    });
    printKey(tenant, code, key, values.raw ?? false);
    return;
  }

  if (cmd === "user:create") {
    const { email, name, role } = values;
    if (!email || !name || !role || !isRoleKey(role)) {
      console.error(HELP);
      process.exit(2);
    }
    if (isPlatformRole(role) === Boolean(values.tenant)) {
      console.error("papel da plataforma não tem cliente; papel de cliente exige --tenant");
      process.exit(2);
    }
    const temp = generateTempPassword();
    const hashed = await hashPassword(temp);
    await withScope(pool, PLATFORM, async (c) => {
      let tenantId: string | null = null;
      if (values.tenant) {
        const t = await c.query<{ id: string }>(
          "SELECT id FROM tenants WHERE slug = $1 AND deleted_at IS NULL",
          [values.tenant],
        );
        if (!t.rows[0]) throw new Error(`cliente ${values.tenant} não encontrado`);
        tenantId = t.rows[0].id;
      }
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id, role_id, name, email, password_hash, must_change_password)
         VALUES ($1, (SELECT id FROM roles WHERE key = $2), $3, $4, $5, true) RETURNING id`,
        [tenantId, role, name, email, hashed],
      );
      await insertAudit(c, {
        tenantId,
        actorType: "cli",
        action: "user.created",
        entityType: "user",
        entityId: rows[0]!.id,
        data: { email, role },
      });
    });
    console.log(
      values.raw ? temp : `Usuário criado. Senha temporária (troca obrigatória): ${temp}`,
    );
    return;
  }

  if (cmd === "user:reset-password" || cmd === "user:disable" || cmd === "user:delete") {
    if (!values.email) {
      console.error(HELP);
      process.exit(2);
    }
    const email = values.email;
    const temp = cmd === "user:reset-password" ? generateTempPassword() : null;
    const hashed = temp ? await hashPassword(temp) : null;
    await withScope(pool, PLATFORM, async (c) => {
      const u = await c.query<{ id: string; tenant_id: string | null }>(
        "SELECT id, tenant_id FROM users WHERE email = $1 AND deleted_at IS NULL",
        [email],
      );
      const user = u.rows[0];
      if (!user) throw new Error(`usuário ${email} não encontrado`);
      if (cmd === "user:delete") {
        await c.query(
          `UPDATE users SET deleted_at = now(), status = 'disabled',
                  email = email || '#excluido-' || extract(epoch from now())::bigint
            WHERE id = $1`,
          [user.id],
        );
        await c.query("DELETE FROM user_camera_permissions WHERE user_id = $1", [user.id]);
      } else if (hashed)
        await c.query(
          `UPDATE users SET password_hash = $2, must_change_password = true, status = 'active',
                  updated_at = now() WHERE id = $1`,
          [user.id, hashed],
        );
      else
        await c.query("UPDATE users SET status = 'disabled', updated_at = now() WHERE id = $1", [
          user.id,
        ]);
      await c.query(
        "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        [user.id],
      );
      await insertAudit(c, {
        tenantId: user.tenant_id,
        actorType: "cli",
        action:
          cmd === "user:delete" ? "user.deleted" : hashed ? "user.password_reset" : "user.disabled",
        entityType: "user",
        entityId: user.id,
        data: { email },
      });
    });
    if (temp)
      console.log(
        values.raw ? temp : `Senha temporária (troca obrigatória no próximo acesso): ${temp}`,
      );
    else
      console.log(
        `Usuário ${email} ${cmd === "user:delete" ? "excluído" : "desativado"}; sessões encerradas.`,
      );
    return;
  }

  console.error(HELP);
  process.exit(2);
}

try {
  await main();
} catch (err) {
  console.error(`erro: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
