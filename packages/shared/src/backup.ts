/**
 * Backup (Fase 8, parte 3) — definições usadas pela API, pelo serviço de backup e pelo painel.
 *
 * Configuração em system_settings 'integrations.backup'. Os campos *_enc são cifrados com
 * STREAM_KEY_ENC_KEY (mesma cifra das chaves das câmeras) e nunca saem da API.
 */

export type BackupProtocol = "sftp" | "ftps" | "ftp";

export interface BackupSettings {
  enabled: boolean;
  /** true = sem destino externo: o arquivo fica só no servidor (baixado pelo painel). */
  local_only: boolean;
  protocol: BackupProtocol;
  host: string;
  port: number;
  username: string;
  /** SFTP: "password" ou "key" (chave privada SSH). FTP/FTPS: sempre "password". */
  auth: "password" | "key";
  password_enc: string | null;
  private_key_enc: string | null;
  /** Pasta no destino (criada se não existir). */
  path: string;
  /** FTPS: conferir o certificado do servidor (desligar só para certificado próprio). */
  verify_certificate: boolean;
  /** SFTP: identidade do servidor registrada no primeiro teste (linhas known_hosts). */
  host_keys: string | null;
  host_key_fingerprint: string | null;
  /** Horário diário "HH:MM" (fuso de Brasília). */
  schedule_time: string;
  retention_remote: number;
  retention_local: number;
  /** Senha do arquivo de backup (cifrada aqui; o dono guarda a original fora do servidor). */
  passphrase_enc: string | null;
  /** Quando foi ligado (base do alerta "sem backup há 26 h" antes do primeiro sucesso). */
  enabled_at: string | null;
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  enabled: false,
  local_only: false,
  protocol: "sftp",
  host: "",
  port: 22,
  username: "",
  auth: "password",
  password_enc: null,
  private_key_enc: null,
  path: "topcam-backups",
  verify_certificate: true,
  host_keys: null,
  host_key_fingerprint: null,
  schedule_time: "03:30",
  retention_remote: 14,
  retention_local: 3,
  passphrase_enc: null,
  enabled_at: null,
};

export const BACKUP_DEFAULT_PORT: Record<BackupProtocol, number> = { sftp: 22, ftps: 21, ftp: 21 };

/** Nome dos arquivos: topcam-AAAAMMDD-HHMMSS.tar.gpg (só esses entram na retenção). */
export const BACKUP_FILE_RE = /^topcam-\d{8}-\d{6}\.tar\.gpg$/;

/** Pasta no destino: letras, números, ponto, hífen, sublinhado e barra; sem "..". */
export const BACKUP_PATH_RE = /^(?!.*\.\.)[A-Za-z0-9._\-/]{1,200}$/;

export const BACKUP_TZ = "America/Sao_Paulo";

/** Mínimo da senha do arquivo de backup. */
export const BACKUP_PASSPHRASE_MIN = 12;

export function mergeBackupSettings(raw: unknown): BackupSettings {
  return { ...DEFAULT_BACKUP_SETTINGS, ...((raw as Partial<BackupSettings> | null) ?? {}) };
}

/** Hora local (fuso informado) como {y, m, d, hh, mm} — sem depender do TZ do contêiner. */
function localParts(at: Date, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { y: +p.year!, m: +p.month!, d: +p.day!, hh: +p.hour!, mm: +p.minute! };
}

/** Converte um horário local (fuso tz) em Date UTC. */
function fromLocal(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  // Estimativa em UTC e correção pela diferença observada (funciona com horário de verão).
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const seen = localParts(new Date(guess), tz);
  const diff = Date.UTC(seen.y, seen.m - 1, seen.d, seen.hh, seen.mm) - guess;
  return new Date(guess - diff);
}

/**
 * Horário agendado mais recente que já passou (hoje, se já passou do horário; senão ontem).
 * O serviço faz o backup se ainda não houve tentativa desde esse horário.
 */
export function lastScheduledSlot(now: Date, scheduleTime: string, tz = BACKUP_TZ): Date {
  const [hh, mm] = scheduleTime.split(":").map(Number) as [number, number];
  const l = localParts(now, tz);
  let slot = fromLocal(l.y, l.m, l.d, hh, mm, tz);
  if (slot.getTime() > now.getTime()) {
    const y = new Date(Date.UTC(l.y, l.m - 1, l.d) - 86_400_000);
    slot = fromLocal(y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate(), hh, mm, tz);
  }
  return slot;
}

/** Próximo horário agendado (para exibir no painel). */
export function nextScheduledSlot(now: Date, scheduleTime: string, tz = BACKUP_TZ): Date {
  const last = lastScheduledSlot(now, scheduleTime, tz);
  const [hh, mm] = scheduleTime.split(":").map(Number) as [number, number];
  // Dia seguinte (no calendário local) ao do último horário, no mesmo horário.
  const l = localParts(last, tz);
  const next = new Date(Date.UTC(l.y, l.m - 1, l.d + 1));
  return fromLocal(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hh, mm, tz);
}

/** Nome do arquivo a partir da data (horário de Brasília). */
export function backupFileName(at: Date, tz = BACKUP_TZ): string {
  const l = localParts(at, tz);
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: tz, second: "2-digit" }).format(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `topcam-${l.y}${pad(l.m)}${pad(l.d)}-${pad(l.hh)}${pad(l.mm)}${pad(Number(s))}.tar.gpg`;
}

/**
 * Quais arquivos apagar para manter só os `keep` mais recentes (nomes ordenam por data).
 * keep = 0 → todos os nossos (ex.: nenhuma cópia local depois de enviar ao destino).
 */
export function filesToPrune(names: string[], keep: number): string[] {
  const ours = names.filter((n) => BACKUP_FILE_RE.test(n)).sort();
  const k = Math.max(0, keep);
  return ours.length > k ? ours.slice(0, ours.length - k) : [];
}

/** Campos cifrados com STREAM_KEY_ENC_KEY (recifrados pela troca da chave de cifra). */
export const BACKUP_ENCRYPTED_FIELDS = [
  "password_enc",
  "private_key_enc",
  "passphrase_enc",
] as const;
