import { execFile } from "node:child_process";
import { readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { PLATFORM, withScope, type Pool } from "@topcam/db";
import { cameraPathName } from "@topcam/shared";
import type { Logger } from "pino";

/**
 * Foto de cada câmera no ar (lista de câmeras do app): um quadro-chave reduzido para 480 px
 * em JPEG, a cada `intervalS` (padrão 5 min). Fica em <dir>/<id da câmera>.jpg; a API entrega
 * só a quem pode ver a câmera. Custa um quadro por câmera a cada 5 min, sem afetar a gravação.
 */

export interface SnapshotOptions {
  pool: Pool;
  log: Logger;
  dir: string;
  /** rtsp://usuário:senha@mediamtx:8554 (leitura interna). */
  rtspBase: string;
  intervalS?: number;
  concurrency?: number;
  ffmpeg?: string;
  timeoutS?: number;
}

const ONLINE = ["recebendo", "validando", "ao_vivo", "gravando"];

export function snapshotArgs(url: string, out: string): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    ...(url.startsWith("rtsp://") ? ["-rtsp_transport", "tcp"] : []),
    "-skip_frame",
    "nokey",
    "-i",
    url,
    "-frames:v",
    "1",
    "-an",
    "-vf",
    "scale=480:-2",
    "-q:v",
    "5",
    "-f",
    "image2",
    "-y",
    out,
  ];
}

export class SnapshotGrabber {
  private running = new Set<string>();
  private lastCleanup = 0;
  constructor(private readonly o: SnapshotOptions) {}

  private file(id: string) {
    return join(this.o.dir, `${id}.jpg`);
  }

  /** Câmeras no ar cuja foto está velha ou não existe. */
  async due(now = Date.now()): Promise<string[]> {
    const ids = await withScope(this.o.pool, PLATFORM, async (c) =>
      (
        await c.query<{ id: string }>(
          `SELECT c.id FROM cameras c JOIN tenants t ON t.id = c.tenant_id
            WHERE c.enabled AND c.deleted_at IS NULL AND t.deleted_at IS NULL AND t.status = 'active'
              AND c.status = ANY($1::text[])
            ORDER BY c.id`,
          [ONLINE],
        )
      ).rows.map((r) => r.id),
    );
    const out: string[] = [];
    const maxAge = (this.o.intervalS ?? 300) * 1000;
    for (const id of ids) {
      if (this.running.has(id)) continue;
      const st = await stat(this.file(id)).catch(() => null);
      if (!st || now - st.mtimeMs >= maxAge) out.push(id);
    }
    return out;
  }

  grab(id: string): Promise<boolean> {
    const tmp = join(this.o.dir, `.${id}.tmp.jpg`);
    const url = `${this.o.rtspBase}/${cameraPathName(id)}`;
    this.running.add(id);
    return new Promise<boolean>((resolve) => {
      execFile(
        this.o.ffmpeg ?? "ffmpeg",
        snapshotArgs(url, tmp),
        { timeout: (this.o.timeoutS ?? 20) * 1000 },
        (err) => {
          void (async () => {
            if (!err && (await stat(tmp).catch(() => null))?.size) {
              await rename(tmp, this.file(id));
              resolve(true);
            } else {
              await unlink(tmp).catch(() => undefined);
              this.o.log.debug({ camera: id, err: err?.message?.slice(0, 200) }, "foto: falhou");
              resolve(false);
            }
          })().finally(() => this.running.delete(id));
        },
      );
    });
  }

  /** Uma rodada: tira as fotos devidas (no máximo `concurrency` por vez). */
  async sync(now = Date.now()): Promise<{ taken: number; failed: number }> {
    const list = await this.due(now);
    const r = { taken: 0, failed: 0 };
    const n = this.o.concurrency ?? 2;
    for (let i = 0; i < list.length; i += n) {
      const ok = await Promise.all(list.slice(i, i + n).map((id) => this.grab(id)));
      for (const x of ok) {
        if (x) r.taken++;
        else r.failed++;
      }
    }
    if (now - this.lastCleanup > 3_600_000) {
      this.lastCleanup = now;
      await this.cleanup().catch(() => undefined);
    }
    return r;
  }

  /** Apaga as fotos de câmeras excluídas. */
  async cleanup(): Promise<number> {
    const files = (await readdir(this.o.dir)).filter((f) => /^[0-9a-f-]{36}\.jpg$/.test(f));
    if (!files.length) return 0;
    const ids = files.map((f) => f.slice(0, 36));
    const alive = new Set(
      await withScope(this.o.pool, PLATFORM, async (c) =>
        (
          await c.query<{ id: string }>(
            "SELECT id FROM cameras WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL",
            [ids],
          )
        ).rows.map((r) => r.id),
      ),
    );
    let n = 0;
    for (const id of ids)
      if (!alive.has(id)) {
        await unlink(this.file(id)).catch(() => undefined);
        n++;
      }
    return n;
  }
}
