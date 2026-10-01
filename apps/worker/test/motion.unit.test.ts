import { describe, expect, it } from "vitest";
import {
  CameraDetector,
  FRAME_BYTES,
  FrameAssembler,
  changedFractionFor,
  compareFrames,
  ffmpegArgs,
  isMotion,
} from "../src/motion/detector.js";

function frame(fill: number): Uint8Array {
  return new Uint8Array(FRAME_BYTES).fill(fill);
}
/** Quadro com um retângulo claro (w×h) na posição x,y, sobre fundo cinza. */
function withBox(x: number, y: number, w: number, h: number, bg = 80, fg = 220): Uint8Array {
  const f = frame(bg);
  for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) f[r * 160 + c] = fg;
  return f;
}

describe("detector de movimento (comparação de quadros)", () => {
  it("sensibilidade vai de 12% a ~0,5% dos pixels", () => {
    expect(changedFractionFor(1)).toBeCloseTo(0.12);
    expect(changedFractionFor(10)).toBeLessThan(0.006);
    expect(changedFractionFor(5)).toBeLessThan(changedFractionFor(4));
  });

  it("quadros iguais não são movimento", () => {
    expect(isMotion(withBox(10, 10, 20, 20), withBox(10, 10, 20, 20), 10)).toBe(false);
  });

  it("objeto que se move é movimento", () => {
    // 20×20 = 400 px saindo e 400 entrando = 800/14400 ≈ 5,6%
    const r = compareFrames(withBox(10, 10, 20, 20), withBox(60, 40, 20, 20));
    expect(r.changed).toBeGreaterThan(0.05);
    expect(isMotion(withBox(10, 10, 20, 20), withBox(60, 40, 20, 20), 5)).toBe(true);
    // Pouco sensível (12%) não dispara com 5,6%.
    expect(isMotion(withBox(10, 10, 20, 20), withBox(60, 40, 20, 20), 1)).toBe(false);
  });

  it("mudança geral de brilho (dia/noite, IR) não é movimento", () => {
    expect(isMotion(frame(60), frame(160), 10)).toBe(false);
    // Clareou um pouco a imagem toda: descontado.
    expect(isMotion(withBox(10, 10, 20, 20, 80, 200), withBox(10, 10, 20, 20, 110, 230), 10)).toBe(
      false,
    );
  });

  it("junta pedaços da saída do ffmpeg em quadros inteiros", () => {
    const asm = new FrameAssembler();
    const got: Uint8Array[] = [];
    const data = Buffer.alloc(FRAME_BYTES * 2 + 100, 7);
    asm.push(data.subarray(0, 5000), (f) => got.push(f));
    asm.push(data.subarray(5000, FRAME_BYTES + 3), (f) => got.push(f));
    asm.push(data.subarray(FRAME_BYTES + 3), (f) => got.push(f));
    expect(got.length).toBe(2);
    expect(got.every((f) => f.length === FRAME_BYTES)).toBe(true);
  });

  it("avisa com o intervalo entre quadros", () => {
    const hits: Array<{ at: number; interval: number }> = [];
    const d = new CameraDetector("x", "rtsp://h/cam/x", 5, {
      onMotion: (at, interval) => hits.push({ at: at.getTime(), interval }),
      onExit: () => undefined,
    });
    d.frame(withBox(10, 10, 20, 20), 1000);
    d.frame(withBox(10, 10, 20, 20), 3000);
    d.frame(withBox(80, 50, 20, 20), 5000);
    expect(hits).toEqual([{ at: 5000, interval: 2000 }]);
  });

  it("ffmpeg decodifica só quadros-chave e reduz para 160×90 cinza", () => {
    const a = ffmpegArgs("rtsp://u:p@mediamtx:8554/cam/1");
    expect(a.join(" ")).toContain("-rtsp_transport tcp -skip_frame nokey -i rtsp://");
    expect(a.join(" ")).toContain("scale=160:90:flags=area,format=gray");
    expect(ffmpegArgs("/tmp/x.mp4")).not.toContain("-rtsp_transport");
  });
});
