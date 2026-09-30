"use client";

import { AlertTriangle, DatabaseBackup, KeyRound, Loader2, Play, PlugZap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, Confirm, ErrorBox, Field, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtBytes, fmtDateTime, fmtRelative } from "@/lib/format";

/**
 * Configurações → Integrações → Backup (Fase 8). Só o Super Admin.
 * Senhas e chave nunca voltam do servidor: em branco mantém as salvas.
 */

type Protocol = "sftp" | "ftps" | "ftp";
interface Settings {
  enabled: boolean;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  auth: "password" | "key";
  hasPassword: boolean;
  hasPrivateKey: boolean;
  path: string;
  verifyCertificate: boolean;
  hostKeyFingerprint: string | null;
  scheduleTime: string;
  retentionRemote: number;
  retentionLocal: number;
  hasPassphrase: boolean;
}
interface Run {
  id: string;
  kind: "backup" | "test";
  trigger: "schedule" | "manual";
  status: "pending" | "running" | "success" | "failed";
  createdAt: string;
  finishedAt: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  message: string | null;
  error: string | null;
  details: { host_key_changed?: boolean };
  requestedBy: string | null;
}
interface BackupInfo {
  settings: Settings;
  service: { alive: boolean; lastSeenAt: string | null; busy: boolean };
  nextRunAt: string | null;
  lastSuccessAt: string | null;
  runs: Run[];
}

const DEFAULT_PORT: Record<Protocol, number> = { sftp: 22, ftps: 21, ftp: 21 };
const STATUS: Record<Run["status"], { label: string; tone: "green" | "red" | "amber" | "slate" }> =
  {
    success: { label: "Concluído", tone: "green" },
    failed: { label: "Falhou", tone: "red" },
    running: { label: "Em andamento", tone: "amber" },
    pending: { label: "Na fila", tone: "slate" },
  };

export function BackupCard() {
  const toast = useToast();
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test" | "run">("");
  const [error, setError] = useState<unknown>(null);
  const [acceptKey, setAcceptKey] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async (resetForm = false) => {
    try {
      const r = await api.get<BackupInfo>("/backup");
      setInfo(r);
      if (resetForm) setForm(r.settings);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load(true);
  }, [load]);

  // Atualiza rápido enquanto houver pedido na fila ou em execução.
  const active = info?.runs.some((r) => r.status === "pending" || r.status === "running");
  useEffect(() => {
    const t = setInterval(() => void load(), active ? 2500 : 20_000);
    return () => clearInterval(t);
  }, [load, active]);

  if (!info || !form)
    return (
      <div className="rounded-lg border border-line p-4">
        <ErrorBox error={error} />
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" /> Carregando backup…
        </div>
      </div>
    );

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));
  const passMismatch = pass1 !== "" && pass1 !== pass2;
  const lastFailedKey = info.runs.find((r) => r.status !== "pending")?.details?.host_key_changed;

  async function save() {
    if (!form) return;
    if (passMismatch) return setError(new Error("As duas senhas do backup não conferem"));
    setBusy("save");
    setError(null);
    try {
      const r = await api.put<{ hostKeyReset: boolean }>("/backup/settings", {
        enabled: form.enabled,
        protocol: form.protocol,
        host: form.host,
        port: form.port,
        username: form.username,
        auth: form.protocol === "sftp" ? form.auth : "password",
        ...(password ? { password } : {}),
        ...(privateKey ? { privateKey } : {}),
        path: form.path,
        verifyCertificate: form.verifyCertificate,
        scheduleTime: form.scheduleTime,
        retentionRemote: form.retentionRemote,
        retentionLocal: form.retentionLocal,
        ...(pass1 ? { passphrase: pass1 } : {}),
      });
      setPassword("");
      setPrivateKey("");
      setPass1("");
      setPass2("");
      toast(
        r.hostKeyReset
          ? "Backup salvo. Servidor trocado: teste a conexão para registrar a nova identidade."
          : "Backup salvo",
      );
      await load(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy("");
    }
  }

  async function request(kind: "test" | "run") {
    setBusy(kind);
    setError(null);
    try {
      await api.post(`/backup/${kind}`, {});
      toast(kind === "test" ? "Teste pedido" : "Backup pedido");
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy("");
    }
  }

  const unsaved =
    JSON.stringify(form) !== JSON.stringify(info.settings) || !!password || !!privateKey || !!pass1;

  return (
    <div className="rounded-lg border border-line p-4" data-testid="backup-card">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <DatabaseBackup size={18} className="text-brand-600" />
        <h3 className="font-medium">Backup</h3>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={form.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
            aria-label="Backup automático diário"
          />
          Backup automático diário
        </label>
      </div>
      <p className="mb-3 text-xs text-muted">
        Banco de dados (cadastros, usuários, câmeras, eventos, índice das gravações, configurações)
        e o arquivo .env, cifrados com a senha do backup. Gravações de vídeo não entram.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={info.service.alive ? "green" : "red"} dot>
          {info.service.alive ? "Serviço de backup ativo" : "Serviço de backup parado"}
        </Badge>
        <span className="text-xs text-muted">
          último backup concluído: {info.lastSuccessAt ? fmtRelative(info.lastSuccessAt) : "nenhum"}
          {info.nextRunAt && <> · próximo: {fmtDateTime(info.nextRunAt)}</>}
        </span>
      </div>
      <ErrorBox error={error} />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
        <Field label="Protocolo" className="md:col-span-2">
          <select
            className="input"
            value={form.protocol}
            onChange={(e) => {
              const p = e.target.value as Protocol;
              setForm((f) => (f ? { ...f, protocol: p, port: DEFAULT_PORT[p] } : f));
            }}
          >
            <option value="sftp">SFTP (recomendado)</option>
            <option value="ftps">FTPS (FTP com TLS)</option>
            <option value="ftp">FTP (sem criptografia)</option>
          </select>
        </Field>
        <Field label="Servidor" className="md:col-span-3">
          <input
            className="input"
            value={form.host}
            onChange={(e) => set("host", e.target.value.trim())}
            placeholder="backup.empresa.com.br ou IP"
          />
        </Field>
        <Field label="Porta" className="md:col-span-1">
          <input
            className="input"
            type="number"
            value={form.port}
            onChange={(e) => set("port", Number(e.target.value))}
          />
        </Field>
        {form.protocol === "ftp" && (
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 md:col-span-6">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            No FTP simples, o usuário e a senha do destino trafegam sem proteção. O arquivo do
            backup continua cifrado, mas prefira SFTP ou FTPS.
          </p>
        )}
        <Field label="Usuário" className="md:col-span-2">
          <input
            className="input"
            autoComplete="off"
            value={form.username}
            onChange={(e) => set("username", e.target.value.trim())}
          />
        </Field>
        {form.protocol === "sftp" && (
          <Field label="Autenticação" className="md:col-span-2">
            <select
              className="input"
              value={form.auth}
              onChange={(e) => set("auth", e.target.value as Settings["auth"])}
            >
              <option value="password">Senha</option>
              <option value="key">Chave SSH</option>
            </select>
          </Field>
        )}
        {form.protocol === "sftp" && form.auth === "key" ? (
          <Field
            label="Chave SSH privada"
            className="md:col-span-6"
            hint={
              info.settings.hasPrivateKey
                ? "Chave salva. Deixe em branco para manter."
                : "Cole a chave PRIVADA sem senha, exclusiva para o backup (a pública vai no servidor)."
            }
          >
            <textarea
              className="input h-24 py-2 font-mono text-xs"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder={
                info.settings.hasPrivateKey ? "••••••••••••" : "-----BEGIN OPENSSH PRIVATE KEY-----"
              }
            />
          </Field>
        ) : (
          <Field
            label="Senha do destino"
            className={form.protocol === "sftp" ? "md:col-span-2" : "md:col-span-4"}
            hint={
              info.settings.hasPassword ? "Senha salva. Deixe em branco para manter." : undefined
            }
          >
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={info.settings.hasPassword ? "••••••••••••" : ""}
            />
          </Field>
        )}
        <Field label="Pasta no destino" className="md:col-span-3" hint="Criada se não existir.">
          <input
            className="input"
            value={form.path}
            onChange={(e) => set("path", e.target.value.trim())}
            placeholder="topcam-backups"
          />
        </Field>
        {form.protocol === "ftps" && (
          <label className="flex items-center gap-2 text-sm md:col-span-3">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={form.verifyCertificate}
              onChange={(e) => set("verifyCertificate", e.target.checked)}
            />
            Conferir o certificado do servidor (desmarque só para certificado próprio)
          </label>
        )}
        {form.protocol === "sftp" && (
          <div className="text-xs text-slate-600 md:col-span-3">
            <span className="text-muted">Identidade do servidor: </span>
            {info.settings.hostKeyFingerprint ? (
              <code className="break-all">{info.settings.hostKeyFingerprint}</code>
            ) : (
              <span>registrada no primeiro teste de conexão</span>
            )}
            {(lastFailedKey || info.settings.hostKeyFingerprint) && (
              <button
                type="button"
                className="ml-2 font-medium text-brand-600 hover:underline"
                onClick={() => setAcceptKey(true)}
              >
                Aceitar nova identidade
              </button>
            )}
          </div>
        )}
        <Field label="Horário diário" className="md:col-span-2" hint="Horário de Brasília.">
          <input
            className="input"
            type="time"
            value={form.scheduleTime}
            onChange={(e) => set("scheduleTime", e.target.value)}
          />
        </Field>
        <Field label="Cópias no destino" className="md:col-span-2">
          <input
            className="input"
            type="number"
            min={1}
            max={365}
            value={form.retentionRemote}
            onChange={(e) => set("retentionRemote", Number(e.target.value))}
          />
        </Field>
        <Field label="Cópias no servidor" className="md:col-span-2">
          <input
            className="input"
            type="number"
            min={0}
            max={30}
            value={form.retentionLocal}
            onChange={(e) => set("retentionLocal", Number(e.target.value))}
          />
        </Field>
      </div>

      <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-900">
          <KeyRound size={16} /> Senha do backup{" "}
          {info.settings.hasPassphrase ? (
            <Badge tone="green">definida</Badge>
          ) : (
            <Badge tone="amber">não definida</Badge>
          )}
        </div>
        <p className="mb-2 text-xs text-amber-900">
          Cifra os arquivos (AES-256). <strong>Guarde-a fora do servidor</strong>: sem ela o backup
          não abre, nem por nós. Ela não é exibida de novo. Trocar a senha vale para os próximos
          backups; os antigos continuam com a senha anterior.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field
            label={info.settings.hasPassphrase ? "Nova senha do backup" : "Senha do backup"}
            hint="Mínimo 12 caracteres."
          >
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={pass1}
              onChange={(e) => setPass1(e.target.value)}
            />
          </Field>
          <Field label="Confirmar senha do backup">
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={pass2}
              onChange={(e) => setPass2(e.target.value)}
            />
          </Field>
        </div>
        {passMismatch && pass2 && (
          <p className="mt-1 text-xs text-red-600">As duas senhas não conferem.</p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className="btn-primary" disabled={busy !== ""} onClick={() => void save()}>
          {busy === "save" && <Loader2 size={16} className="animate-spin" />} Salvar
        </button>
        <button
          className="btn-secondary"
          disabled={busy !== "" || !!active || unsaved}
          onClick={() => void request("test")}
          title={unsaved ? "Salve antes de testar" : undefined}
        >
          {busy === "test" ? <Loader2 size={16} className="animate-spin" /> : <PlugZap size={16} />}{" "}
          Testar conexão
        </button>
        <button
          className="btn-secondary"
          disabled={busy !== "" || !!active || unsaved || !info.settings.hasPassphrase}
          onClick={() => void request("run")}
          title={unsaved ? "Salve antes" : undefined}
        >
          {busy === "run" ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}{" "}
          Fazer backup agora
        </button>
        {unsaved && <span className="text-xs text-amber-700">Alterações não salvas</span>}
      </div>

      <div className="mt-5">
        <h4 className="mb-2 text-sm font-medium">Histórico</h4>
        {info.runs.length === 0 ? (
          <p className="text-sm text-muted">Nenhum backup ou teste ainda.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Histórico do backup">
              <thead>
                <tr>
                  <th className="th">Quando</th>
                  <th className="th">Tipo</th>
                  <th className="th">Resultado</th>
                  <th className="th hidden md:table-cell">Arquivo</th>
                  <th className="th">Detalhe</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(showAll ? info.runs : info.runs.slice(0, 6)).map((r) => (
                  <tr key={r.id}>
                    <td className="td whitespace-nowrap text-xs">{fmtDateTime(r.createdAt)}</td>
                    <td className="td text-xs">
                      {r.kind === "test" ? "Teste" : "Backup"}
                      <span className="block text-muted">
                        {r.trigger === "schedule" ? "agendado" : (r.requestedBy ?? "manual")}
                      </span>
                    </td>
                    <td className="td">
                      <Badge tone={STATUS[r.status].tone}>
                        {(r.status === "running" || r.status === "pending") && (
                          <Loader2 size={12} className="animate-spin" />
                        )}
                        {STATUS[r.status].label}
                      </Badge>
                    </td>
                    <td className="td hidden text-xs md:table-cell">
                      {r.fileName ? (
                        <>
                          <code className="break-all">{r.fileName}</code>
                          {r.sizeBytes != null && (
                            <span className="block text-muted">{fmtBytes(r.sizeBytes)}</span>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td
                      className={`td min-w-[14rem] whitespace-normal text-xs ${r.error ? "text-red-700" : "text-slate-600"}`}
                    >
                      {r.error ?? r.message ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {info.runs.length > 6 && (
              <button
                type="button"
                className="mt-2 text-xs font-medium text-brand-600 hover:underline"
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? "Mostrar só os últimos" : `Mostrar os ${info.runs.length} últimos`}
              </button>
            )}
          </div>
        )}
      </div>

      <Confirm
        open={acceptKey}
        title="Aceitar nova identidade do servidor"
        confirmLabel="Aceitar e registrar no próximo teste"
        message={
          <>
            Use só se o servidor SFTP foi <b>trocado ou reinstalado de propósito</b>. Se ninguém
            mexeu nele, a mudança de identidade pode indicar um servidor impostor — não aceite e
            verifique com quem administra o destino.
          </>
        }
        onClose={() => setAcceptKey(false)}
        onConfirm={async () => {
          await api.post("/backup/accept-host-key", {});
          toast("Identidade esquecida. Clique em Testar conexão para registrar a nova.");
          await load(true);
        }}
      />
    </div>
  );
}
