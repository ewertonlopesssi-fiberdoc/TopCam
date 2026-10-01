import { PLATFORM, insertCameraEvent, recordMotionHit, withScope, type Pool } from "@topcam/db";
import { cameraPathName } from "@topcam/shared";
import type { Logger } from "pino";
import { CameraDetector } from "./detector.js";

/**
 * Mantém um detector (ffmpeg) para cada câmera com detecção pelo servidor que está no ar.
 * Câmera fora do ar, desligada ou que mudou de origem: o detector para. Se o ffmpeg cai,
 * volta sozinho com espera crescente; falhas seguidas viram um evento da câmera.
 */

export interface ManagerOptions {
  pool: Pool;
  log: Logger;
  /** rtsp://usuário:senha@mediamtx:8554 (leitura interna). */
  rtspBase: string;
  ffmpeg?: string;
  /** Limite de detectores simultâneos (proteção da CPU). */
  maxDetectors?: number;
}

interface Slot {
  det: CameraDetector;
  code: string;
  tenantId: string;
  failures: number;
  retryAt: number;
  lastErrorEventAt: number;
}

const ONLINE = ["recebendo", "validando", "ao_vivo", "gravando"];

export class MotionManager {
  private slots = new Map<string, Slot>();
  constructor(private readonly o: ManagerOptions) {}

  get active(): number {
    return [...this.slots.values()].filter((s) => s.det.running).length;
  }

  async sync(now = Date.now()): Promise<{ running: number; wanted: number }> {
    const cams = await withScope(
      this.o.pool,
      PLATFORM,
      async (c) =>
        (
          await c.query<{
            id: string;
            code: string;
            tenant_id: string;
            motion_sensitivity: number;
          }>(
            `SELECT c.id, c.code, c.tenant_id, c.motion_sensitivity
             FROM cameras c JOIN tenants t ON t.id = c.tenant_id
            WHERE c.motion_source = 'server' AND c.enabled AND c.deleted_at IS NULL
              AND t.status = 'active' AND t.deleted_at IS NULL
              AND c.status = ANY($1::text[])
            ORDER BY c.created_at
            LIMIT $2`,
            [ONLINE, this.o.maxDetectors ?? 64],
          )
        ).rows,
    );
    const wanted = new Set(cams.map((c) => c.id));
    for (const [id, s] of this.slots)
      if (!wanted.has(id)) {
        s.det.stop();
        this.slots.delete(id);
      }
    for (const cam of cams) {
      let s = this.slots.get(cam.id);
      if (!s) {
        const det: CameraDetector = new CameraDetector(
          cam.id,
          `${this.o.rtspBase}/${cameraPathName(cam.id)}`,
          cam.motion_sensitivity,
          {
            onMotion: (at, intervalMs) => void this.hit(cam.id, at, intervalMs),
            onExit: (code, stderr) => void this.exited(cam.id, code, stderr),
          },
          this.o.ffmpeg,
        );
        s = {
          det,
          code: cam.code,
          tenantId: cam.tenant_id,
          failures: 0,
          retryAt: 0,
          lastErrorEventAt: 0,
        };
        this.slots.set(cam.id, s);
      }
      s.det.sensitivity = cam.motion_sensitivity;
      if (!s.det.running && now >= s.retryAt) s.det.start();
    }
    return { running: this.active, wanted: wanted.size };
  }

  stopAll(): void {
    for (const s of this.slots.values()) s.det.stop();
    this.slots.clear();
  }

  private async hit(cameraId: string, at: Date, intervalMs: number) {
    const s = this.slots.get(cameraId);
    if (s) s.failures = 0;
    try {
      await withScope(this.o.pool, PLATFORM, (c) =>
        recordMotionHit(c, {
          cameraId,
          source: "server",
          kind: "motion",
          // O movimento aconteceu entre o quadro anterior e este.
          at: new Date(at.getTime() - intervalMs),
          until: at,
        }),
      );
    } catch (err) {
      this.o.log.warn({ err: (err as Error).message }, "movimento: falha ao registrar");
    }
  }

  private async exited(cameraId: string, code: number | null, stderr: string) {
    const s = this.slots.get(cameraId);
    if (!s) return; // parado de propósito
    s.failures++;
    const wait = Math.min(10_000 * 2 ** Math.min(s.failures - 1, 3), 80_000);
    s.retryAt = Date.now() + wait;
    this.o.log.info(
      { camera: s.code, code, failures: s.failures, err: stderr.slice(-300) },
      "movimento: detector parou",
    );
    if (s.failures >= 5 && Date.now() - s.lastErrorEventAt > 3_600_000) {
      s.lastErrorEventAt = Date.now();
      await withScope(this.o.pool, PLATFORM, (c) =>
        insertCameraEvent(c, {
          tenantId: s.tenantId,
          cameraId,
          type: "motion_detector_error",
          severity: "warning",
          message: `Detector de movimento de ${s.code} falhou ${s.failures} vezes seguidas`,
          data: { exit_code: code, error: stderr.slice(-300) },
        }),
      ).catch(() => undefined);
    }
  }
}
