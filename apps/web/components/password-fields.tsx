"use client";

import { Eye, EyeOff } from "lucide-react";
import { useId, useState } from "react";

/** Regra de senha (a mesma validada pela API). */
export const PASSWORD_RULE =
  "Mínimo de 8 caracteres, com 1 letra maiúscula, 1 minúscula e 1 número.";

export function passwordProblem(p: string): string | null {
  if (p.length < 8) return "A senha deve ter pelo menos 8 caracteres.";
  if (!/[A-Z]/.test(p)) return "A senha deve ter ao menos 1 letra maiúscula.";
  if (!/[a-z]/.test(p)) return "A senha deve ter ao menos 1 letra minúscula.";
  if (!/[0-9]/.test(p)) return "A senha deve ter ao menos 1 número.";
  return null;
}

export function PasswordInput({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  const [show, setShow] = useState(false);
  const id = `pw${useId().replace(/:/g, "")}`;
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          className="input pr-10"
          type={show ? "text" : "password"}
          autoComplete="new-password"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="absolute top-1/2 right-2 -translate-y-1/2 p-1 text-slate-500 hover:text-brand-600"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "Ocultar senha" : "Mostrar senha"}
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </div>
  );
}

export interface PasswordState {
  password: string;
  confirm: string;
  /** null = automático (obrigatória só quando a senha é gerada). */
  mustChange: boolean | null;
  sendEmail: boolean;
}
export const emptyPassword = (sendEmail = false): PasswordState => ({
  password: "",
  confirm: "",
  mustChange: null,
  sendEmail,
});

/** Erro de validação local (antes de enviar) ou null. */
export function passwordStateError(s: PasswordState): string | null {
  if (!s.password && !s.confirm) return null;
  const p = passwordProblem(s.password);
  if (p) return p;
  if (s.password !== s.confirm) return "A confirmação não confere com a senha.";
  return null;
}

/** Campos enviados à API. */
export function passwordPayload(s: PasswordState) {
  return {
    ...(s.password ? { password: s.password } : {}),
    mustChangePassword: s.mustChange ?? !s.password,
    sendEmail: s.sendEmail,
  };
}

/**
 * Bloco "Senha" dos formulários de usuário: senha e confirmação (em branco = o sistema
 * gera), troca obrigatória no primeiro acesso e envio dos dados de acesso por e-mail.
 */
export function PasswordFields({
  state,
  onChange,
  mailEnabled,
  optionalLabel,
}: {
  state: PasswordState;
  onChange: (s: PasswordState) => void;
  mailEnabled: boolean;
  optionalLabel: string;
}) {
  const set = (patch: Partial<PasswordState>) => onChange({ ...state, ...patch });
  const mustChange = state.mustChange ?? !state.password;
  const err = passwordStateError(state);
  return (
    <div className="space-y-3 rounded-lg border border-line p-3" data-testid="password-fields">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <PasswordInput
          label="Senha"
          value={state.password}
          onChange={(v) => set({ password: v })}
          placeholder={optionalLabel}
        />
        <PasswordInput
          label="Confirmar senha"
          value={state.confirm}
          onChange={(v) => set({ confirm: v })}
          placeholder={optionalLabel}
        />
      </div>
      <p className={`text-xs ${state.password && err ? "text-red-700" : "text-muted"}`}>
        {state.password && err ? err : PASSWORD_RULE}
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={mustChange}
          onChange={(e) => set({ mustChange: e.target.checked })}
        />
        Exigir troca de senha no primeiro acesso
      </label>
      <label className={`flex items-start gap-2 text-sm ${mailEnabled ? "" : "text-muted"}`}>
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={state.sendEmail && mailEnabled}
          disabled={!mailEnabled}
          onChange={(e) => set({ sendEmail: e.target.checked })}
        />
        <span>
          Enviar usuário e senha por e-mail
          {!mailEnabled && (
            <span className="block text-xs">
              Configure o e-mail em Configurações → Integrações para usar esta opção.
            </span>
          )}
        </span>
      </label>
    </div>
  );
}
