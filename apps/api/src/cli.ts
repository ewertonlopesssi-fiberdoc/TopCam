#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  PLATFORM,
  createPool,
  findCameraByCode,
  insertAudit,
  insertCameraEvent,
  reencryptSecrets,
  rotateStreamKey,
  withScope,
} from "@topcam/db";
import {
  BACKUP_ENCRYPTED_FIELDS,
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
 *   recording:status [--tenant <slug>]     (gravações: horas disponíveis, espaço, lacunas, problemas)
 *   secrets:reencrypt                      (Fase 8: recifra o banco; chaves pelo stdin, nunca na linha de comando)
 *   secrets:rotated --names <grupos>       (Fase 8: auditoria da troca de segredos, sem valores)
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
  user:delete         --email <e-mail>
  recording:status    [--tenant <slug>]
  secrets:reencrypt   (lê 2 linhas do stdin: chave antiga e chave nova, base64)
  secrets:check       (confere se tudo abre com a STREAM_KEY_ENC_KEY em uso)
  secrets:rotated     --names <jwt,media,db,enc>   (registra a troca na auditoria)`;

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
    names: { type: "string" },
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

async function readStdinLines(n: number): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const lines = Buffer.concat(chunks)
    .toString("utf8")
    .split(/\r?\n/)
    .map((l) => l.trim());
  return lines.filter(Boolean).slice(0, n);
}

async function main() {
  if (cmd === "secrets:reencrypt") {
    const [oldB64, newB64] = await readStdinLines(2);
    if (!oldB64 || !newB64)
      throw new Error("informe no stdin a chave antiga e a nova (uma por linha)");
    const oldKey = parseEncryptionKey(oldB64);
    const newKey = parseEncryptionKey(newB64);
    const r = await withScope(pool, PLATFORM, async (c) => {
      const res = await reencryptSecrets(c, oldKey, newKey);
      await insertAudit(c, {
        tenantId: null,
        actorType: "cli",
        action: "secrets.reencrypted",
        entityType: "secret",
        entityId: "STREAM_KEY_ENC_KEY",
        data: {
          cameras: res.cameras,
          camerasAlreadyNew: res.camerasAlreadyNew,
          smtp: res.smtp,
          backup: res.backup,
        },
      });
      return res;
    });
    console.log(
      `recifrado: ${r.cameras} chave(s) de câmera` +
        (r.camerasAlreadyNew ? ` (${r.camerasAlreadyNew} já na chave nova)` : "") +
        `; senha do SMTP: ${{ reencrypted: "recifrada", already_new: "já na chave nova", none: "não configurada" }[r.smtp]}` +
        `; backup: ${r.backup} campo(s) recifrado(s)`,
    );
    return;
  }

  if (cmd === "secrets:check") {
    const r = await withScope(pool, PLATFORM, async (c) => {
      const cams = (
        await c.query<{ code: string; stream_key_enc: string }>(
          "SELECT code, stream_key_enc FROM cameras WHERE stream_key_enc IS NOT NULL",
        )
      ).rows;
      const smtp = (
        await c.query<{ enc: string | null }>(
          "SELECT value->>'password_enc' AS enc FROM system_settings WHERE key = 'integrations.smtp'",
        )
      ).rows[0]?.enc;
      let ok = 0;
      const bad: string[] = [];
      for (const cam of cams) {
        try {
          decryptStreamKey(cam.stream_key_enc, encKey);
          ok++;
        } catch {
          bad.push(cam.code);
        }
      }
      let smtpOk: boolean | null = null;
      if (smtp) {
        try {
          decryptStreamKey(smtp, encKey);
          smtpOk = true;
        } catch {
          smtpOk = false;
        }
      }
      const bkp = (
        await c.query<{ value: Record<string, string | null> }>(
          "SELECT value FROM system_settings WHERE key = 'integrations.backup'",
        )
      ).rows[0]?.value;
      let backupBad = 0;
      for (const f of BACKUP_ENCRYPTED_FIELDS) {
        const v = bkp?.[f];
        if (!v) continue;
        try {
          decryptStreamKey(v, encKey);
        } catch {
          backupBad++;
        }
      }
      return { ok, bad, smtpOk, backupBad };
    });
    console.log(
      `chaves de câmera legíveis: ${r.ok}; ilegíveis: ${r.bad.length}${r.bad.length ? ` (${r.bad.slice(0, 10).join(", ")})` : ""}; ` +
        `senha do SMTP: ${r.smtpOk === null ? "não configurada" : r.smtpOk ? "legível" : "ILEGÍVEL"}; ` +
        `senhas do backup: ${r.backupBad ? `${r.backupBad} ILEGÍVEL(IS)` : "ok"}`,
    );
    if (r.bad.length || r.smtpOk === false || r.backupBad) process.exitCode = 1;
    return;
  }

  if (cmd === "secrets:rotated") {
    const names = (values.names ?? "")
      .split(",")
      .map((n) => n.trim())
      .filter((n) => ["jwt", "media", "db", "enc"].includes(n));
    if (!names.length) throw new Error("use --names com jwt, media, db e/ou enc");
    await withScope(pool, PLATFORM, (c) =>
      insertAudit(c, {
        tenantId: null,
        actorType: "cli",
        action: "secrets.rotated",
        entityType: "secret",
        entityId: names.join(","),
        data: { groups: names },
      }),
    );
    console.log(`auditoria: troca de segredos registrada (${names.join(", ")})`);
    return;
  }

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

  if (cmd === "recording:status") {
    const rows = await withScope(
      pool,
      PLATFORM,
      async (c) =>
        (
          await c.query(
            `SELECT t.slug AS cliente, c.code AS camera, c.status,
                    CASE WHEN c.recording_enabled THEN coalesce(rp.retention_hours, 24) || ' h' ELSE 'não' END AS grava,
                    count(s.*) FILTER (WHERE s.state = 'verified') AS segmentos,
                    round(extract(epoch FROM (max(s.ended_at) FILTER (WHERE s.state = 'verified')
                          - min(s.started_at) FILTER (WHERE s.state = 'verified'))) / 3600, 2) AS horas,
                    pg_size_pretty(coalesce(sum(s.size_bytes) FILTER (WHERE s.state = 'verified'), 0)) AS espaco,
                    to_char(min(s.started_at) FILTER (WHERE s.state = 'verified') AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS mais_antigo,
                    to_char(c.last_durable_segment_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI:SS') AS ultimo_segmento,
                    count(s.*) FILTER (WHERE s.state IN ('corrupt', 'missing')) AS problemas,
                    (SELECT count(*) FROM camera_events e WHERE e.camera_id = c.id AND e.type = 'recording_gap'
                        AND e.occurred_at > now() - interval '24 hours') AS lacunas_24h
               FROM cameras c
               JOIN tenants t ON t.id = c.tenant_id
               LEFT JOIN retention_policies rp ON rp.id = c.retention_policy_id
               LEFT JOIN recording_segments s ON s.camera_id = c.id AND s.state <> 'deleted'
              WHERE c.deleted_at IS NULL AND ($1::text IS NULL OR t.slug = $1)
              GROUP BY t.slug, c.id, c.code, c.status, c.recording_enabled, rp.retention_hours, c.last_durable_segment_at
             HAVING c.recording_enabled OR count(s.*) > 0
              ORDER BY t.slug, c.code`,
            [values.tenant ?? null],
          )
        ).rows,
    );
    const global = await withScope(
      pool,
      PLATFORM,
      async (c) =>
        (
          await c.query(
            "SELECT value FROM system_settings WHERE key = 'recording.globally_enabled'",
          )
        ).rows[0]?.value,
    );
    console.log(`Gravação geral: ${global === true ? "ligada" : "DESLIGADA"}`);
    if (rows.length) console.table(rows);
    else console.log("Nenhuma câmera com gravação.");
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
