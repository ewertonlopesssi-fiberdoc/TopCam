import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CAMERA_STATUSES,
  decryptStreamKey,
  encryptStreamKey,
  generateStreamKey,
  hashStreamKey,
  isValidStreamKeyFormat,
  mediaPathForKey,
  nextCameraStatus,
  parseEncryptionKey,
  parseMtxDuration,
  parseSegmentPath,
  recordDirForCamera,
  cameraPathName,
  safeEqual,
  streamKeyFromPath,
  type CameraStatus,
} from "../src/index.js";

describe("chaves de transmissão", () => {
  it("gera chaves de 40 caracteres alfanuméricos e únicas", () => {
    const keys = new Set(Array.from({ length: 2000 }, () => generateStreamKey()));
    expect(keys.size).toBe(2000);
    for (const k of keys) expect(isValidStreamKeyFormat(k)).toBe(true);
  });

  it("rejeita formatos inválidos", () => {
    expect(isValidStreamKeyFormat("")).toBe(false);
    expect(isValidStreamKeyFormat("abc")).toBe(false);
    expect(isValidStreamKeyFormat("a".repeat(39) + "-")).toBe(false);
    expect(isValidStreamKeyFormat("a".repeat(41))).toBe(false);
  });

  it("hash é determinístico e diferente da chave", () => {
    const k = generateStreamKey();
    expect(hashStreamKey(k)).toBe(hashStreamKey(k));
    expect(hashStreamKey(k)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashStreamKey(k)).not.toContain(k);
  });

  it("cifra e decifra (AES-256-GCM) e detecta adulteração", () => {
    const encKey = parseEncryptionKey(randomBytes(32).toString("base64"));
    const k = generateStreamKey();
    const enc = encryptStreamKey(k, encKey);
    expect(enc).not.toContain(k);
    expect(decryptStreamKey(enc, encKey)).toBe(k);
    const parts = enc.split(".");
    const tampered = [parts[0], parts[1], parts[2], "AAAA" + parts[3]!.slice(4)].join(".");
    expect(() => decryptStreamKey(tampered, encKey)).toThrow();
    const otherKey = parseEncryptionKey(randomBytes(32).toString("base64"));
    expect(() => decryptStreamKey(enc, otherKey)).toThrow();
  });

  it("exige chave de cifra de 32 bytes", () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow();
  });

  it("safeEqual compara corretamente", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("caminhos de mídia", () => {
  it("monta e interpreta live/<chave>", () => {
    const k = generateStreamKey();
    expect(streamKeyFromPath(mediaPathForKey(k))).toBe(k);
    expect(streamKeyFromPath("live/curta")).toBeNull();
    expect(streamKeyFromPath(`outro/${k}`)).toBeNull();
    expect(streamKeyFromPath(`live/${k}/extra`)).toBeNull();
  });

  it("grava por ID da câmera, nunca pela chave", () => {
    expect(cameraPathName("abc-123")).toBe("cam/abc-123");
    expect(recordDirForCamera("/recordings/", "abc-123")).toBe("/recordings/cam/abc-123");
  });
});

describe("máquina de estados da câmera", () => {
  it("segue o fluxo normal até ao vivo", () => {
    let s: CameraStatus = "aguardando_transmissao";
    s = nextCameraStatus(s, "publish_authorized")!;
    expect(s).toBe("conectando");
    s = nextCameraStatus(s, "stream_online")!;
    expect(s).toBe("recebendo");
    s = nextCameraStatus(s, "probe_started")!;
    expect(s).toBe("validando");
    s = nextCameraStatus(s, "probe_succeeded")!;
    expect(s).toBe("ao_vivo");
  });

  it("só chega a 'gravando' após segmento verificado, e nunca direto de recebendo", () => {
    for (const st of CAMERA_STATUSES) {
      const n = nextCameraStatus(st, "first_segment_verified");
      if (st === "ao_vivo") expect(n).toBe("gravando");
      else expect(n).toBeNull();
    }
    for (const st of CAMERA_STATUSES) {
      for (const ev of ["publish_authorized", "stream_online", "probe_succeeded"] as const) {
        expect(nextCameraStatus(st, ev)).not.toBe("gravando");
      }
    }
  });

  it("queda leva a offline a partir de qualquer estado de transmissão", () => {
    for (const st of ["conectando", "recebendo", "validando", "ao_vivo", "gravando"] as const) {
      expect(nextCameraStatus(st, "stream_offline")).toBe("offline");
    }
    expect(nextCameraStatus("aguardando_transmissao", "stream_offline")).toBeNull();
    expect(nextCameraStatus("offline", "stream_offline")).toBeNull();
  });

  it("timeout de conexão volta ao estado ocioso adequado", () => {
    expect(nextCameraStatus("conectando", "connect_timeout", { everStreamed: false })).toBe(
      "aguardando_transmissao",
    );
    expect(nextCameraStatus("conectando", "connect_timeout", { everStreamed: true })).toBe(
      "offline",
    );
    expect(nextCameraStatus("ao_vivo", "connect_timeout")).toBeNull();
  });

  it("câmera desabilitada ignora tudo exceto 'enabled'", () => {
    for (const ev of ["publish_authorized", "stream_online", "probe_succeeded"] as const) {
      expect(nextCameraStatus("desabilitada", ev)).toBeNull();
    }
    expect(nextCameraStatus("desabilitada", "enabled")).toBe("aguardando_transmissao");
    expect(nextCameraStatus("ao_vivo", "disabled")).toBe("desabilitada");
  });

  it("reconexão após offline volta a recebendo", () => {
    expect(nextCameraStatus("offline", "stream_online")).toBe("recebendo");
    expect(nextCameraStatus("erro", "stream_online")).toBe("recebendo");
    expect(nextCameraStatus("ao_vivo", "stream_online")).toBeNull();
  });
});

describe("segmentos de gravação", () => {
  const id = "4405e718-4a2c-4c26-a580-d8755d8e5271";

  it("interpreta o caminho do MediaMTX (absoluto ou relativo) e o início em UTC", () => {
    const abs = parseSegmentPath(`/recordings/cam/${id}/2026-09-29_00-45-46-515667.mp4`);
    expect(abs).toEqual({
      cameraId: id,
      relPath: `cam/${id}/2026-09-29_00-45-46-515667.mp4`,
      startedAt: new Date("2026-09-29T00:45:46.515Z"),
    });
    expect(parseSegmentPath(`cam/${id}/2026-09-29_00-45-46-515667.mp4`)?.cameraId).toBe(id);
    expect(
      parseSegmentPath(`/dados/cam/${id}/2026-09-29_00-45-46-515667.mp4`, "/dados/")?.cameraId,
    ).toBe(id);
  });

  it("recusa caminhos fora do padrão", () => {
    for (const bad of [
      `/recordings/live/${"a".repeat(40)}/2026-09-29_00-45-46-515667.mp4`,
      `/recordings/cam/${id}/../../etc/passwd`,
      `/recordings/cam/${id}/2026-09-29_00-45-46.mp4`,
      `/recordings/cam/nao-e-uuid/2026-09-29_00-45-46-515667.mp4`,
      `/outra/cam/${id}/2026-09-29_00-45-46-515667.mp4`,
      `/recordings/cam/${id}/2026-13-45_00-45-46-515667.mp4x`,
    ])
      expect(parseSegmentPath(bad), bad).toBeNull();
  });

  it("converte a duração informada pelo MediaMTX", () => {
    expect(parseMtxDuration("60.033s")).toBe(60033);
    expect(parseMtxDuration("1m0.5s")).toBe(60500);
    expect(parseMtxDuration("59.9")).toBe(59900);
    expect(parseMtxDuration("750ms")).toBe(750);
    expect(parseMtxDuration("")).toBeNull();
    expect(parseMtxDuration("abc")).toBeNull();
  });
});
