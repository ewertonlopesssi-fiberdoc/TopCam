#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  PLATFORM,
  createPool,
  enqueueJob,
  findCameraByCode,
  insertAudit,
  insertCameraEvent,
  transitionCamera,
  withScope,
} from "@topcam/db";
import {
  decryptStreamKey,
  encryptStreamKey,
  generateStreamKey,
  hashStreamKey,
  parseEncryptionKey,
  streamKeyPrefix,
} from "@topcam/shared";

/**
 * CLI administrativa (Fase 1 — as telas chegam na Fase 2).
 *
 *   camera:list      [--tenant <slug>]
 *   camera:show-key  --tenant <slug> --code <CAM-001> [--raw]
 *   camera:rotate-key --tenant <slug> --code <CAM-001> [--raw]
 *
 * Exemplo no Compose:
 *   docker compose exec api node apps/api/dist/cli.js camera:show-key --tenant empresa-alfa --code CAM-001
 */

const HELP = `uso:
  camera:list       [--tenant <slug>]
  camera:show-key   --tenant <slug> --code <código> [--raw]
  camera:rotate-key --tenant <slug> --code <código> [--raw]`;

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
      const newKey = generateStreamKey();
      await c.query(
        `UPDATE cameras SET stream_key_hash = $2, stream_key_enc = $3, stream_key_prefix = $4,
                stream_key_rotated_at = now() WHERE id = $1`,
        [
          camera.id,
          hashStreamKey(newKey),
          encryptStreamKey(newKey, encKey),
          streamKeyPrefix(newKey),
        ],
      );
      await insertAudit(c, {
        tenantId: camera.tenant_id,
        actorType: "cli",
        action: "camera.stream_key_rotated",
        entityType: "camera",
        entityId: camera.id,
        data: { code, new_prefix: streamKeyPrefix(newKey) },
      });
      // A sessão aberta com a chave antiga deixa de valer (será desconectada pelo
      // reconciliador); a câmera fica offline até publicar com a chave nova.
      await transitionCamera(c, camera.id, "stream_offline", "key_rotated");
      await insertCameraEvent(c, {
        tenantId: camera.tenant_id,
        cameraId: camera.id,
        type: "key_rotated",
        severity: "warning",
        message: `Chave de transmissão de ${code} foi trocada; a chave anterior deixou de valer`,
      });
      // O reconciliador remove o caminho antigo e desconecta quem ainda usa a chave anterior.
      await enqueueJob(
        c,
        "mediamtx.reconcile",
        { reason: "key_rotated" },
        { dedupKey: "reconcile" },
      );
      return newKey;
    });
    printKey(tenant, code, key, values.raw ?? false);
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
