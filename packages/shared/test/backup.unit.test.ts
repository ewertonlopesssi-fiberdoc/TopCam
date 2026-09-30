import { describe, expect, it } from "vitest";
import {
  backupFileName,
  filesToPrune,
  lastScheduledSlot,
  nextScheduledSlot,
  BACKUP_FILE_RE,
  BACKUP_PATH_RE,
} from "../src/backup.js";

describe("agenda do backup (horário de Brasília)", () => {
  it("antes do horário: último agendamento é ontem; depois: hoje", () => {
    // 30/09/2026 02:00 em Brasília = 05:00 UTC
    expect(lastScheduledSlot(new Date("2026-09-30T05:00:00Z"), "03:30").toISOString()).toBe(
      "2026-09-29T06:30:00.000Z",
    );
    // 30/09/2026 04:00 em Brasília = 07:00 UTC
    expect(lastScheduledSlot(new Date("2026-09-30T07:00:00Z"), "03:30").toISOString()).toBe(
      "2026-09-30T06:30:00.000Z",
    );
  });

  it("próximo agendamento", () => {
    expect(nextScheduledSlot(new Date("2026-09-30T07:00:00Z"), "03:30").toISOString()).toBe(
      "2026-10-01T06:30:00.000Z",
    );
    expect(nextScheduledSlot(new Date("2026-09-30T05:00:00Z"), "03:30").toISOString()).toBe(
      "2026-09-30T06:30:00.000Z",
    );
  });

  it("próximo agendamento em horários da tarde e perto da meia-noite", () => {
    // 30/09 14:41 em Brasília (17:41Z), agendado 14:40 → amanhã 14:40
    expect(nextScheduledSlot(new Date("2026-09-30T17:41:00Z"), "14:40").toISOString()).toBe(
      "2026-10-01T17:40:00.000Z",
    );
    // 30/09 23:55 em Brasília (02:55Z do dia 01), agendado 23:50 → 01/10 23:50 (02:50Z do dia 02)
    expect(nextScheduledSlot(new Date("2026-10-01T02:55:00Z"), "23:50").toISOString()).toBe(
      "2026-10-02T02:50:00.000Z",
    );
    // 30/09 00:10 em Brasília, agendado 23:50 → hoje 23:50 (ainda não passou)
    expect(nextScheduledSlot(new Date("2026-09-30T03:10:00Z"), "23:50").toISOString()).toBe(
      "2026-10-01T02:50:00.000Z",
    );
    // Virada de mês e de ano
    expect(nextScheduledSlot(new Date("2026-12-31T20:00:00Z"), "10:00").toISOString()).toBe(
      "2027-01-01T13:00:00.000Z",
    );
  });

  it("nome do arquivo no horário de Brasília e padrão reconhecido", () => {
    const n = backupFileName(new Date("2026-09-30T06:30:07Z"));
    expect(n).toBe("topcam-20260930-033007.tar.gpg");
    expect(BACKUP_FILE_RE.test(n)).toBe(true);
  });
});

describe("retenção", () => {
  it("apaga só os mais antigos do nosso padrão", () => {
    const names = [
      "topcam-20260901-033000.tar.gpg",
      "outro-arquivo.txt",
      "topcam-20260903-033000.tar.gpg",
      "topcam-20260902-033000.tar.gpg",
      "topcam-20260904-033000.tar.gpg.part",
    ];
    expect(filesToPrune(names, 2)).toEqual(["topcam-20260901-033000.tar.gpg"]);
    expect(filesToPrune(names, 5)).toEqual([]);
    expect(filesToPrune(names, 0)).toEqual([]);
  });

  it("pasta: aceita caminhos simples, recusa .. e caracteres de shell", () => {
    expect(BACKUP_PATH_RE.test("backups/topcam")).toBe(true);
    expect(BACKUP_PATH_RE.test("/srv/backup-01")).toBe(true);
    expect(BACKUP_PATH_RE.test("../etc")).toBe(false);
    expect(BACKUP_PATH_RE.test("a;rm -rf")).toBe(false);
    expect(BACKUP_PATH_RE.test("a b")).toBe(false);
  });
});
