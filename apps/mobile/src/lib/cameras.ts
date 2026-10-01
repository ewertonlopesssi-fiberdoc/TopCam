/** Câmeras do usuário agrupadas por local e grupo (sem dependência de React Native). */

export interface Camera {
  id: string;
  code: string;
  name: string;
  tenantId: string;
  tenantName: string;
  locationId: string;
  locationName: string;
  groupId: string | null;
  groupName: string | null;
  status: string;
  lastVideoAt: string | null;
  recordingEnabled: boolean;
  enabled: boolean;
}

export interface CameraGroup {
  key: string;
  title: string;
  cameras: Camera[];
}

export interface CameraSection {
  key: string;
  /** "Local" ou "Cliente › Local" quando o usuário vê mais de um cliente. */
  title: string;
  groups: CameraGroup[];
}

const byName = (a: string, b: string) => a.localeCompare(b, "pt-BR", { sensitivity: "base" });

export function buildTree(cameras: Camera[]): CameraSection[] {
  const multiTenant = new Set(cameras.map((c) => c.tenantId)).size > 1;
  const sections = new Map<string, CameraSection>();
  for (const c of cameras) {
    const sKey = `${c.tenantId}/${c.locationId}`;
    let s = sections.get(sKey);
    if (!s) {
      s = {
        key: sKey,
        title: multiTenant ? `${c.tenantName} › ${c.locationName}` : c.locationName,
        groups: [],
      };
      sections.set(sKey, s);
    }
    const gKey = `${sKey}/${c.groupId ?? "-"}`;
    let g = s.groups.find((x) => x.key === gKey);
    if (!g) {
      g = { key: gKey, title: c.groupName ?? "Sem grupo", cameras: [] };
      s.groups.push(g);
    }
    g.cameras.push(c);
  }
  const out = [...sections.values()].sort((a, b) => byName(a.title, b.title));
  for (const s of out) {
    // "Sem grupo" por último.
    s.groups.sort((a, b) =>
      a.title === "Sem grupo" ? 1 : b.title === "Sem grupo" ? -1 : byName(a.title, b.title),
    );
    for (const g of s.groups) g.cameras.sort((a, b) => byName(a.name, b.name));
  }
  return out;
}

export type Tone = "green" | "red" | "amber" | "slate";

export const CAMERA_STATUS: Record<string, { label: string; tone: Tone }> = {
  aguardando_transmissao: { label: "Aguardando", tone: "slate" },
  conectando: { label: "Conectando", tone: "amber" },
  recebendo: { label: "Recebendo", tone: "amber" },
  validando: { label: "Validando", tone: "amber" },
  ao_vivo: { label: "Online", tone: "green" },
  gravando: { label: "Gravando", tone: "green" },
  offline: { label: "Sem sinal", tone: "red" },
  erro: { label: "Erro", tone: "red" },
  desabilitada: { label: "Desabilitada", tone: "slate" },
};

export function statusOf(status: string) {
  return CAMERA_STATUS[status] ?? { label: status, tone: "slate" as Tone };
}

/** Câmera com vídeo agora (vale a pena abrir o ao vivo). */
export function isOnline(status: string): boolean {
  return ["recebendo", "validando", "ao_vivo", "gravando"].includes(status);
}

/** Divide em páginas de até `size` (mosaico de 4). */
export function pages<T>(items: T[], size = 4): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Regras de senha da API (mínimo 8, maiúscula, minúscula e número). */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return "A senha precisa ter pelo menos 8 caracteres.";
  if (!/[A-Z]/.test(pw)) return "A senha precisa ter pelo menos uma letra maiúscula.";
  if (!/[a-z]/.test(pw)) return "A senha precisa ter pelo menos uma letra minúscula.";
  if (!/[0-9]/.test(pw)) return "A senha precisa ter pelo menos um número.";
  return null;
}
