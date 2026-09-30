"use client";

import { CheckCircle2, Loader2, Mail, Send, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BackupCard } from "@/components/backup-card";
import { ErrorBox, Field, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";

/**
 * Configurações → Integrações → E-mail (SMTP). Só o Super Admin.
 * A senha nunca volta do servidor: em branco mantém a salva.
 */

interface Smtp {
  enabled: boolean;
  host: string;
  port: number;
  security: "starttls" | "tls" | "none";
  username: string;
  hasPassword: boolean;
  fromName: string;
  fromEmail: string;
  recipients: string[];
  minSeverity: "warning" | "error" | "critical";
  notifyResolved: boolean;
}
interface Sent {
  id: string;
  kind: string;
  recipients: string;
  subject: string;
  status: "sent" | "failed";
  error: string | null;
  createdAt: string;
}

const KIND: Record<string, string> = {
  alert: "Alerta",
  resolved: "Resolvido",
  digest: "Resumo",
  test: "Teste",
  access: "Acesso",
};

export function IntegrationsCard() {
  const toast = useToast();
  const [smtp, setSmtp] = useState<Smtp | null>(null);
  const [recipients, setRecipients] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState<Sent[]>([]);
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ smtp: Smtp; notifications: Sent[] }>("/integrations");
      setSmtp(r.smtp);
      setRecipients(r.smtp.recipients.join("\n"));
      setSent(r.notifications);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!smtp)
    return (
      <section className="card p-5">
        <h2 className="font-semibold">Integrações</h2>
        <ErrorBox error={error} />
      </section>
    );

  const set = <K extends keyof Smtp>(k: K, v: Smtp[K]) =>
    setSmtp((s) => (s ? { ...s, [k]: v } : s));

  async function save() {
    setBusy("save");
    setError(null);
    try {
      await api.put("/integrations/smtp", {
        enabled: smtp!.enabled,
        host: smtp!.host.trim(),
        port: Number(smtp!.port),
        security: smtp!.security,
        username: smtp!.username.trim(),
        ...(password ? { password } : {}),
        fromName: smtp!.fromName,
        fromEmail: smtp!.fromEmail.trim(),
        recipients,
        minSeverity: smtp!.minSeverity,
        notifyResolved: smtp!.notifyResolved,
      });
      setPassword("");
      toast("Integração de e-mail salva");
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    setError(null);
    try {
      const r = await api.post<{ to: string[] }>(
        "/integrations/smtp/test",
        testTo ? { to: testTo } : {},
      );
      toast(`E-mail de teste enviado para ${r.to.join(", ")}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy("");
      await load();
    }
  }

  return (
    <section className="card p-5" data-testid="integrations">
      <h2 className="font-semibold">Integrações</h2>
      <p className="mb-4 text-sm text-muted">Serviços externos usados pela plataforma.</p>

      <div className="rounded-lg border border-line p-4" data-testid="integrations-smtp">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Mail size={18} className="text-brand-600" />
          <h3 className="font-medium">E-mail (SMTP) — alertas</h3>
          <label className="ml-auto flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={smtp.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
              aria-label="Enviar alertas por e-mail"
            />
            Enviar alertas por e-mail
          </label>
        </div>
        <ErrorBox error={error} />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
          <Field label="Servidor SMTP" className="md:col-span-3">
            <input
              className="input"
              value={smtp.host}
              onChange={(e) => set("host", e.target.value)}
            />
          </Field>
          <Field label="Porta" className="md:col-span-1">
            <input
              className="input"
              type="number"
              value={smtp.port}
              onChange={(e) => set("port", Number(e.target.value))}
            />
          </Field>
          <Field label="Segurança" className="md:col-span-2">
            <select
              className="input"
              value={smtp.security}
              onChange={(e) => set("security", e.target.value as Smtp["security"])}
            >
              <option value="starttls">STARTTLS (porta 587)</option>
              <option value="tls">SSL/TLS (porta 465)</option>
              <option value="none">Nenhuma</option>
            </select>
          </Field>
          <Field label="Usuário" className="md:col-span-3">
            <input
              className="input"
              autoComplete="off"
              value={smtp.username}
              onChange={(e) => set("username", e.target.value)}
              placeholder="seu.email@gmail.com"
            />
          </Field>
          <Field
            label="Senha"
            className="md:col-span-3"
            hint={
              smtp.hasPassword
                ? "Senha salva. Deixe em branco para manter."
                : "No Gmail: senha de app."
            }
          >
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={smtp.hasPassword ? "••••••••••••" : ""}
            />
          </Field>
          <Field label="Nome do remetente" className="md:col-span-3">
            <input
              className="input"
              value={smtp.fromName}
              onChange={(e) => set("fromName", e.target.value)}
            />
          </Field>
          <Field label="E-mail do remetente" className="md:col-span-3">
            <input
              className="input"
              type="email"
              value={smtp.fromEmail}
              onChange={(e) => set("fromEmail", e.target.value)}
              placeholder="igual ao usuário, no Gmail"
            />
          </Field>
          <Field label="Destinatários (um por linha)" className="md:col-span-3">
            <textarea
              className="input h-24 py-2"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder={"noc@empresa.com.br\nsuporte@empresa.com.br"}
            />
          </Field>
          <div className="space-y-3 md:col-span-3">
            <Field label="Enviar a partir da gravidade">
              <select
                className="input"
                value={smtp.minSeverity}
                onChange={(e) => set("minSeverity", e.target.value as Smtp["minSeverity"])}
              >
                <option value="warning">Atenção (tudo)</option>
                <option value="error">Erro (câmera sem sinal, disco alto…)</option>
                <option value="critical">Só crítico</option>
              </select>
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={smtp.notifyResolved}
                onChange={(e) => set("notifyResolved", e.target.checked)}
              />
              Avisar também quando o alerta for resolvido
            </label>
          </div>
        </div>

        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
          <strong>Gmail:</strong> servidor <code>smtp.gmail.com</code>, porta <code>587</code>,
          STARTTLS, usuário = o e-mail completo. A senha é uma <strong>senha de app</strong> (Conta
          Google → Segurança → Verificação em duas etapas → Senhas de app); a senha normal da conta
          é recusada. Limite do Gmail: ~500 e-mails por dia.
          <button
            type="button"
            className="ml-2 font-medium text-brand-600 hover:underline"
            onClick={() =>
              setSmtp((s) =>
                s
                  ? {
                      ...s,
                      host: "smtp.gmail.com",
                      port: 587,
                      security: "starttls",
                      fromEmail: s.fromEmail || s.username,
                    }
                  : s,
              )
            }
          >
            Preencher para Gmail
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <button className="btn-primary" disabled={busy !== ""} onClick={() => void save()}>
            {busy === "save" && <Loader2 size={16} className="animate-spin" />} Salvar
          </button>
          <div className="ml-auto flex flex-wrap items-end gap-2">
            <Field label="Enviar teste para (opcional)" className="w-64">
              <input
                className="input"
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="os destinatários salvos"
              />
            </Field>
            <button className="btn-secondary" disabled={busy !== ""} onClick={() => void test()}>
              {busy === "test" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Send size={16} />
              )}{" "}
              Enviar e-mail de teste
            </button>
          </div>
        </div>
        <p className="mt-1 text-xs text-muted">
          O teste usa a configuração salva — salve antes de testar.
        </p>

        {sent.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-1 text-xs font-medium text-muted">Últimos envios</h4>
            <ul
              className="divide-y divide-line rounded-lg border border-line text-xs"
              data-testid="sent-list"
            >
              {sent.map((n) => (
                <li key={n.id} className="flex flex-wrap items-start gap-2 px-3 py-2">
                  {n.status === "sent" ? (
                    <CheckCircle2
                      size={14}
                      className="mt-0.5 text-green-600"
                      aria-label="Enviado"
                    />
                  ) : (
                    <XCircle size={14} className="mt-0.5 text-red-600" aria-label="Falhou" />
                  )}
                  <span className="w-28 shrink-0 text-muted">{fmtDateTime(n.createdAt)}</span>
                  <span className="w-16 shrink-0">{KIND[n.kind] ?? n.kind}</span>
                  <span className="min-w-0 flex-1">
                    {n.subject}
                    <span className="block text-muted">para {n.recipients}</span>
                    {n.error && <span className="block text-red-700">{n.error}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="mt-4">
        <BackupCard />
      </div>
    </section>
  );
}
