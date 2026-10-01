"use client";

import { BellRing, Eye, Mail, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Confirm, CopyButton, Field, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtDateTime, fmtRelative } from "@/lib/format";

/**
 * Cadastro da câmera — detecção de movimento, gravação só com movimento e alarme.
 * Os horários do alarme valem só para a notificação; a gravação por movimento é 24 h.
 */

export interface AlarmRule {
  days: number[];
  from: string;
  to: string;
}
export interface MotionValue {
  motionSource: "off" | "camera" | "server";
  motionSensitivity: number;
  alarmEnabled: boolean;
  alarmSchedule: { rules: AlarmRule[] };
  alarmCooldownS: number;
  alarmEmail: boolean;
}

export const MOTION_DEFAULT: MotionValue = {
  motionSource: "off",
  motionSensitivity: 5,
  alarmEnabled: false,
  alarmSchedule: { rules: [] },
  alarmCooldownS: 300,
  alarmEmail: true,
};

const DAYS = ["D", "S", "T", "Q", "Q", "S", "S"];
const DAY_NAMES = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const COOLDOWNS = [
  { s: 60, label: "1 minuto" },
  { s: 300, label: "5 minutos" },
  { s: 900, label: "15 minutos" },
  { s: 1800, label: "30 minutos" },
  { s: 3600, label: "1 hora" },
];

export const MOTION_SOURCE_LABEL: Record<string, string> = {
  off: "Desligada",
  camera: "Pela câmera (aviso por e-mail)",
  server: "Pelo servidor (análise do vídeo)",
};

export function MotionSettings({
  value,
  onChange,
}: {
  value: MotionValue;
  onChange: (v: MotionValue) => void;
}) {
  const set = (p: Partial<MotionValue>) => onChange({ ...value, ...p });
  const rules = value.alarmSchedule.rules;
  const setRules = (r: AlarmRule[]) => set({ alarmSchedule: { rules: r } });
  const off = value.motionSource === "off";

  return (
    <div className="space-y-3" data-testid="motion-settings">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Detecção de movimento">
          <select
            className="input"
            value={value.motionSource}
            onChange={(e) => {
              const src = e.target.value as MotionValue["motionSource"];
              set({ motionSource: src, ...(src === "off" ? { alarmEnabled: false } : {}) });
            }}
          >
            {Object.entries(MOTION_SOURCE_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {value.motionSource === "server" && (
          <Field label={`Sensibilidade: ${value.motionSensitivity}`}>
            <input
              type="range"
              min={1}
              max={10}
              className="mt-2 w-full accent-brand-600"
              value={value.motionSensitivity}
              onChange={(e) => set({ motionSensitivity: Number(e.target.value) })}
              aria-label="Sensibilidade"
            />
          </Field>
        )}
      </div>
      {value.motionSource === "camera" && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          A câmera detecta (ex.: Intelbras VIP, com detecção de pessoa) e avisa o TopCam por e-mail.
          Depois de salvar, gere o usuário e a senha em{" "}
          <b>detalhes da câmera → Eventos da câmera</b> e configure no e-mail (SMTP) da câmera, com
          a ação de enviar e-mail no evento.
        </p>
      )}
      {value.motionSource === "server" && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          O servidor compara as imagens da câmera a cada 1–2 s. Serve para qualquer câmera, mas não
          diferencia pessoa de outros movimentos (sombra, chuva, galhos). Ajuste a sensibilidade se
          houver avisos demais ou de menos.
        </p>
      )}

      <div className="rounded-lg border border-line p-3">
        <label className={`flex items-center gap-2 text-sm font-medium ${off ? "opacity-50" : ""}`}>
          <input
            type="checkbox"
            className="h-4 w-4 accent-brand-600"
            checked={value.alarmEnabled}
            disabled={off}
            onChange={(e) => set({ alarmEnabled: e.target.checked })}
            data-testid="alarm-enabled"
          />
          <BellRing size={15} /> Alarme: notificar quando houver movimento
        </label>
        {off && (
          <p className="mt-1 text-xs text-muted">
            Escolha a detecção de movimento para ligar o alarme.
          </p>
        )}
        {value.alarmEnabled && !off && (
          <div className="mt-3 space-y-3">
            <div>
              <div className="mb-1 text-xs font-medium text-slate-700">Horários do alarme</div>
              {rules.length === 0 && (
                <p className="text-xs text-muted">Sempre (todos os dias, 24 h).</p>
              )}
              <ul className="space-y-2">
                {rules.map((r, i) => (
                  <li
                    key={i}
                    className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-2"
                    data-testid="alarm-rule"
                  >
                    <div className="flex gap-1" role="group" aria-label="Dias da semana">
                      {DAYS.map((d, n) => {
                        const on = r.days.includes(n);
                        return (
                          <button
                            key={n}
                            type="button"
                            title={DAY_NAMES[n]}
                            aria-label={DAY_NAMES[n]}
                            aria-pressed={on}
                            className={`h-7 w-7 rounded-full text-xs font-medium ${
                              on ? "bg-brand-600 text-white" : "bg-white ring-1 ring-line"
                            }`}
                            onClick={() =>
                              setRules(
                                rules.map((x, j) =>
                                  j === i
                                    ? {
                                        ...x,
                                        days: on
                                          ? x.days.filter((y) => y !== n)
                                          : [...x.days, n].sort(),
                                      }
                                    : x,
                                ),
                              )
                            }
                          >
                            {d}
                          </button>
                        );
                      })}
                    </div>
                    <span className="flex items-center gap-1 text-xs">
                      das
                      <input
                        type="time"
                        className="input h-8 w-[6.5rem] px-2"
                        value={r.from}
                        aria-label="Início"
                        onChange={(e) =>
                          setRules(
                            rules.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)),
                          )
                        }
                      />
                      às
                      <input
                        type="time"
                        className="input h-8 w-[6.5rem] px-2"
                        value={r.to}
                        aria-label="Fim"
                        onChange={(e) =>
                          setRules(
                            rules.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)),
                          )
                        }
                      />
                    </span>
                    <button
                      type="button"
                      className="icon-btn ml-auto h-8 w-8"
                      aria-label="Remover horário"
                      onClick={() => setRules(rules.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="mt-2 text-xs font-medium text-brand-600 hover:underline"
                onClick={() =>
                  setRules([...rules, { days: [0, 1, 2, 3, 4, 5, 6], from: "22:00", to: "06:00" }])
                }
              >
                <Plus size={12} className="inline" /> Adicionar horário
              </button>
              <p className="mt-1 text-[11px] text-muted">
                Fora desses horários a câmera continua detectando e gravando, só não notifica. Uma
                faixa como 22:00–06:00 atravessa a meia-noite. Horário de Brasília.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Intervalo mínimo entre avisos">
                <select
                  className="input"
                  value={value.alarmCooldownS}
                  onChange={(e) => set({ alarmCooldownS: Number(e.target.value) })}
                >
                  {COOLDOWNS.map((c) => (
                    <option key={c.s} value={c.s}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-brand-600"
                  checked={value.alarmEmail}
                  onChange={(e) => set({ alarmEmail: e.target.checked })}
                />
                <Mail size={14} /> Enviar e-mail
              </label>
            </div>
            <p className="text-[11px] text-muted">
              Recebem os usuários do cliente com acesso a esta câmera (e o administrador do
              cliente). A notificação no aplicativo chega com o app.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

interface Credential {
  smtp: { server: string; port: number; user: string; password: string; to: string; tls: string };
}

/** Detalhes da câmera: usuário e senha com que a câmera avisa o movimento por e-mail. */
export function MotionCredentialBox({
  cameraId,
  user,
  rotatedAt,
  lastMotionAt,
  onChanged,
}: {
  cameraId: string;
  user: string | null | undefined;
  rotatedAt: string | null | undefined;
  lastMotionAt: string | null | undefined;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [cred, setCred] = useState<Credential | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  async function generate() {
    setBusy(true);
    try {
      setCred(await api.post<Credential>(`/cameras/${cameraId}/motion-credential`));
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  const rows: [string, string][] = cred
    ? [
        ["Servidor SMTP", cred.smtp.server],
        ["Porta", String(cred.smtp.port)],
        ["Usuário", cred.smtp.user],
        ["Senha", cred.smtp.password],
        ["Destinatário", cred.smtp.to],
      ]
    : [];
  return (
    <section className="mt-6 rounded-xl border border-line p-4" data-testid="motion-credential">
      <h3 className="mb-1 flex items-center gap-2 font-semibold">
        <Mail size={16} /> Eventos da câmera (e-mail)
      </h3>
      <p className="mb-3 text-xs text-muted">
        {user ? (
          <>
            Usuário <span className="font-mono">{user}</span>
            {rotatedAt && <> · gerado em {fmtDateTime(rotatedAt)}</>}. Último movimento:{" "}
            {lastMotionAt ? fmtRelative(lastMotionAt) : "nenhum"}.
          </>
        ) : (
          "Nenhuma credencial gerada ainda."
        )}
      </p>
      {cred && (
        <div
          className="mb-3 space-y-2 rounded-lg bg-slate-50 p-3 text-sm"
          data-testid="motion-credential-data"
        >
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-xs text-muted">{k}</span>
              <span className="min-w-0 flex-1 break-all font-mono text-xs">{v}</span>
              <CopyButton value={v} />
            </div>
          ))}
          <p className="text-[11px] text-muted">
            Criptografia: {cred.smtp.tls}. A senha só aparece agora: anote ou configure na câmera.
            Na câmera, ligue a ação <b>enviar e-mail</b> no evento (movimento ou detecção de pessoa)
            e use o botão de teste: o TopCam registra &quot;E-mail de teste da câmera recebido&quot;
            nos eventos.
          </p>
        </div>
      )}
      <button
        className="btn-secondary w-full"
        disabled={busy}
        onClick={() => (user ? setConfirm(true) : void generate())}
      >
        <Eye size={16} /> {user ? "Gerar nova senha" : "Gerar usuário e senha"}
      </button>
      <Confirm
        open={confirm}
        danger
        title="Gerar nova senha de eventos"
        confirmLabel="Gerar nova senha"
        message="A senha atual deixa de funcionar na hora. Será preciso configurar a nova na câmera."
        onClose={() => setConfirm(false)}
        onConfirm={generate}
      />
    </section>
  );
}
