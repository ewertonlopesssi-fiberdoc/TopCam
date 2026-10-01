import { describe, expect, it } from "vitest";
import {
  alarmActiveAt,
  classifyMotionMail,
  generateSmtpCredential,
  hashSmtpPassword,
  isTestMail,
  localWeekMinute,
  normalizeSchedule,
} from "../src/motion.js";

// Brasília = UTC-3 (sem horário de verão desde 2019).
const br = (iso: string) => new Date(`${iso}-03:00`);

describe("agenda do alarme", () => {
  it("sem regras vale sempre", () => {
    expect(alarmActiveAt({ rules: [] }, br("2026-10-01T14:00:00"))).toBe(true);
    expect(alarmActiveAt(null, br("2026-10-01T14:00:00"))).toBe(true);
  });

  it("dia da semana e minuto no fuso de Brasília", () => {
    // 01/10/2026 é quinta-feira.
    expect(localWeekMinute(br("2026-10-01T23:30:00"))).toEqual({ dow: 4, min: 23 * 60 + 30 });
    expect(localWeekMinute(new Date("2026-10-02T02:30:00Z"))).toEqual({
      dow: 4,
      min: 23 * 60 + 30,
    });
  });

  it("faixa no mesmo dia: início incluído, fim excluído", () => {
    const s = { rules: [{ days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00" }] };
    expect(alarmActiveAt(s, br("2026-10-01T08:00:00"))).toBe(true);
    expect(alarmActiveAt(s, br("2026-10-01T17:59:00"))).toBe(true);
    expect(alarmActiveAt(s, br("2026-10-01T18:00:00"))).toBe(false);
    expect(alarmActiveAt(s, br("2026-10-03T10:00:00"))).toBe(false); // sábado
  });

  it("faixa que atravessa a meia-noite pertence ao dia em que começa", () => {
    // Só sexta (5) das 22:00 às 06:00.
    const s = { rules: [{ days: [5], from: "22:00", to: "06:00" }] };
    expect(alarmActiveAt(s, br("2026-10-02T23:00:00"))).toBe(true); // sexta 23h
    expect(alarmActiveAt(s, br("2026-10-03T05:59:00"))).toBe(true); // madrugada de sábado
    expect(alarmActiveAt(s, br("2026-10-03T06:00:00"))).toBe(false);
    expect(alarmActiveAt(s, br("2026-10-03T23:00:00"))).toBe(false); // sábado 23h
    expect(alarmActiveAt(s, br("2026-10-02T03:00:00"))).toBe(false); // madrugada de sexta (de quinta)
  });

  it("from = to cobre o dia inteiro", () => {
    const s = { rules: [{ days: [0, 6], from: "00:00", to: "00:00" }] };
    expect(alarmActiveAt(s, br("2026-10-04T13:00:00"))).toBe(true); // domingo
    expect(alarmActiveAt(s, br("2026-10-05T13:00:00"))).toBe(false); // segunda
  });

  it("normaliza dias repetidos e fora da faixa", () => {
    expect(
      normalizeSchedule({ rules: [{ days: [3, 1, 3, 9], from: "01:00", to: "02:00" }] }),
    ).toEqual({
      rules: [{ days: [1, 3], from: "01:00", to: "02:00" }],
    });
  });
});

describe("credencial e e-mails da câmera", () => {
  it("usuário e senha só com letras e números, únicos", () => {
    const a = generateSmtpCredential();
    const b = generateSmtpCredential();
    expect(a.user).toMatch(/^cam[a-z0-9]{9}$/);
    expect(a.password).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(a.user).not.toBe(b.user);
    expect(hashSmtpPassword(a.user, a.password)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSmtpPassword(a.user, a.password)).not.toBe(hashSmtpPassword(b.user, a.password));
  });

  it("tipo do aviso pelo texto", () => {
    expect(classifyMotionMail("Alarm Event: Motion Detection", "")).toBe("motion");
    expect(classifyMotionMail("Evento", "Detecção inteligente de movimento (humano)")).toBe(
      "human",
    );
    expect(classifyMotionMail("SMD alarm", "")).toBe("human");
    expect(classifyMotionMail("Audio Detection", "")).toBe("audio");
    expect(classifyMotionMail("", "")).toBe("motion");
  });

  it("e-mail de teste da câmera", () => {
    expect(isTestMail("Test")).toBe(true);
    expect(isTestMail("Teste de e-mail")).toBe(true);
    expect(isTestMail("Motion Detection")).toBe(false);
  });
});
