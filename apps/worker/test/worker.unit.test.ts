import { describe, expect, it } from "vitest";
import { redact } from "../src/context.js";
import { summarizeProbe } from "../src/jobs/probe.js";
import { diffPathConfs, type DesiredPath } from "../src/jobs/reconcile.js";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrameRate, probeFile } from "../src/lib/ffprobe.js";

const KEY = "A".repeat(40);

function desired(name: string, record = false): DesiredPath {
  return {
    name,
    cameraId: "c1",
    code: "CAM-001",
    conf: { source: "publisher", overridePublisher: false, record },
  };
}

describe("reconciliação: diff de caminhos", () => {
  it("adiciona, atualiza e remove só caminhos gerenciados (live/ e cam/)", () => {
    const d = [desired("live/a"), desired("live/b", true)];
    const existing = [
      { name: "all_others" },
      { name: "live/b", source: "publisher", record: false, overridePublisher: false },
      { name: "live/antiga", record: false },
      { name: "cam/antiga", record: false },
    ];
    const r = diffPathConfs(d, existing);
    expect(r.add.map((x) => x.name)).toEqual(["live/a"]);
    expect(r.patch.map((x) => x.name)).toEqual(["live/b"]);
    expect(r.remove).toEqual(["live/antiga", "cam/antiga"]);
  });

  it("nada a fazer quando já está igual", () => {
    const d = [desired("live/a")];
    const r = diffPathConfs(d, [{ name: "live/a", ...d[0]!.conf }]);
    expect(r).toEqual({ add: [], patch: [], remove: [] });
  });
});

describe("validação do stream", () => {
  it("resume a saída do ffprobe", () => {
    const s = summarizeProbe([
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        avg_frame_rate: "25/1",
        profile: "Main",
      },
      { codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 1 },
    ]);
    expect(s).toEqual({
      videoCodec: "h264",
      audioCodec: "aac",
      width: 1920,
      height: 1080,
      fps: 25,
      profile: "Main",
    });
    expect(summarizeProbe([]).videoCodec).toBeNull();
  });

  it("interpreta taxas de quadro", () => {
    expect(parseFrameRate("30000/1001")).toBe(29.97);
    expect(parseFrameRate("0/0")).toBeNull();
    expect(parseFrameRate(undefined)).toBeNull();
  });

  it("remove chaves e credenciais de mensagens", () => {
    const msg = `rtsp://topcam-internal:segredo@mediamtx:8554/live/${KEY}: 404`;
    const out = redact(msg);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain("segredo");
  });
});

describe("conferência de segmento: ffprobe", () => {
  it("tempo esgotado vira falha passageira com mensagem clara (disco travado)", async () => {
    // Um FIFO sem quem escreva deixa o ffprobe bloqueado, como num disco travado.
    const fifo = join(tmpdir(), `topcam-fifo-${process.pid}.mp4`);
    execFileSync("mkfifo", [fifo]);
    try {
      const err = await probeFile(fifo, 1).catch((e: Error & { transient?: boolean }) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("tempo esgotado (1 s)");
      expect((err as { transient?: boolean }).transient).toBe(true);
    } finally {
      rmSync(fifo, { force: true });
    }
  });
});
