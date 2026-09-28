const TZ = "America/Sao_Paulo";

export function fmtDateTime(value?: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function fmtRelative(value?: string | null): string {
  if (!value) return "—";
  const diff = (Date.now() - new Date(value).getTime()) / 1000;
  if (diff < 30) return "agora";
  if (diff < 3600) return `há ${Math.round(diff / 60)} min`;
  if (diff < 86400) return `há ${Math.round(diff / 3600)} h`;
  return fmtDateTime(value);
}

export function fmtBytes(bytes?: number | null): string {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1).replace(".", ",")} ${units[i]}`;
}

export function pad3(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : String(n).padStart(3, "0");
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export const CAMERA_STATUS: Record<string, { label: string; tone: Tone }> = {
  aguardando_transmissao: { label: "Aguardando", tone: "slate" },
  conectando: { label: "Conectando", tone: "amber" },
  recebendo: { label: "Recebendo", tone: "amber" },
  validando: { label: "Validando", tone: "amber" },
  ao_vivo: { label: "Online", tone: "green" },
  gravando: { label: "Gravando", tone: "red" },
  offline: { label: "Offline", tone: "red" },
  erro: { label: "Erro", tone: "red" },
  desabilitada: { label: "Desabilitada", tone: "slate" },
};

export const TENANT_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "Ativo", tone: "green" },
  suspended: { label: "Suspenso", tone: "red" },
  cancelled: { label: "Cancelado", tone: "slate" },
};

export const USER_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "Ativo", tone: "green" },
  disabled: { label: "Desativado", tone: "slate" },
  invited: { label: "Convidado", tone: "amber" },
};

export type Tone = "green" | "red" | "amber" | "slate" | "blue";

export const AUDIT_LABELS: Record<string, string> = {
  "auth.login": "Entrou no sistema",
  "auth.login_failed": "Falha de login",
  "auth.login_blocked": "Login bloqueado",
  "auth.logout": "Saiu do sistema",
  "auth.password_changed": "Trocou a senha",
  "auth.refresh_reuse_detected": "Reuso de sessão detectado",
  "tenant.created": "Cliente criado",
  "tenant.updated": "Cliente alterado",
  "tenant.suspended": "Cliente suspenso",
  "tenant.activated": "Cliente reativado",
  "tenant.cancelled": "Cliente cancelado",
  "user.created": "Usuário criado",
  "auth.login_rate_limited": "Login bloqueado por excesso de tentativas",
  "user.updated": "Usuário alterado",
  "user.disabled": "Usuário desativado",
  "user.password_reset": "Senha redefinida",
  "user.camera_permissions_updated": "Permissões de câmeras alteradas",
  "location.created": "Local criado",
  "location.updated": "Local alterado",
  "location.deleted": "Local excluído",
  "camera_group.created": "Grupo criado",
  "camera_group.updated": "Grupo alterado",
  "camera_group.deleted": "Grupo excluído",
  "camera.created": "Câmera cadastrada",
  "camera.updated": "Câmera alterada",
  "camera.disabled": "Câmera desativada",
  "camera.enabled": "Câmera reativada",
  "camera.deleted": "Câmera excluída",
  "camera.stream_key_viewed": "Chave RTMP exibida",
  "camera.stream_key_rotated": "Chave RTMP trocada",
  "plan.updated": "Plano alterado",
  "settings.updated": "Configurações alteradas",
};
