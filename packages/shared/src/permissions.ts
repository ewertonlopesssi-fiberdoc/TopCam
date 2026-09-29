/**
 * Papéis e permissões (especificação §4).
 *
 * - Equipe da plataforma (users.tenant_id = NULL): platform_admin, platform_operator.
 * - Usuários de cliente: tenant_admin, operator, viewer.
 * - Visibilidade de câmeras: plataforma e tenant_admin veem todas (do escopo);
 *   operator e viewer veem apenas as câmeras concedidas em user_camera_permissions.
 * - Chaves RTMP só são exibidas/rotacionadas pela equipe da plataforma.
 */

export const ROLE_KEYS = [
  "platform_admin",
  "platform_operator",
  "tenant_admin",
  "operator",
  "viewer",
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const PLATFORM_ROLES: ReadonlySet<RoleKey> = new Set([
  "platform_admin",
  "platform_operator",
]);
export const TENANT_ROLES: ReadonlySet<RoleKey> = new Set(["tenant_admin", "operator", "viewer"]);

export const PERMISSIONS = [
  "tenants.read",
  "tenants.write",
  "plans.read",
  "users.read",
  "users.write",
  "permissions.write",
  "locations.read",
  "locations.write",
  "cameras.read",
  "cameras.write",
  "cameras.keys",
  "settings.read",
  "settings.write",
  "audit.read",
  "storage.read",
  "storage.write",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MATRIX: Record<RoleKey, readonly Permission[]> = {
  platform_admin: PERMISSIONS,
  platform_operator: [
    "tenants.read",
    "plans.read",
    "users.read",
    "locations.read",
    "locations.write",
    "cameras.read",
    "cameras.write",
    "cameras.keys",
    "settings.read",
    "audit.read",
    "storage.read",
  ],
  tenant_admin: [
    "tenants.read",
    "plans.read",
    "users.read",
    "users.write",
    "permissions.write",
    "locations.read",
    "cameras.read",
    "audit.read",
  ],
  operator: ["locations.read", "cameras.read"],
  viewer: ["locations.read", "cameras.read"],
};

export function isRoleKey(v: string): v is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(v);
}

export function can(role: RoleKey, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}

export function permissionsOf(role: RoleKey): Permission[] {
  return [...MATRIX[role]];
}

export function isPlatformRole(role: RoleKey): boolean {
  return PLATFORM_ROLES.has(role);
}

/** "all" = todas as câmeras do escopo; "granted" = somente as concedidas ao usuário. */
export function cameraVisibility(role: RoleKey): "all" | "granted" {
  return role === "operator" || role === "viewer" ? "granted" : "all";
}

/** Papéis que `actor` pode atribuir a outros usuários. */
export function assignableRoles(actor: RoleKey): RoleKey[] {
  if (actor === "platform_admin") return [...ROLE_KEYS];
  if (actor === "tenant_admin") return ["tenant_admin", "operator", "viewer"];
  return [];
}

export const ROLE_LABELS: Record<RoleKey, string> = {
  platform_admin: "Super Admin",
  platform_operator: "Operador da plataforma",
  tenant_admin: "Administrador do cliente",
  operator: "Operador",
  viewer: "Visualizador",
};

/** Papéis que só veem câmeras concedidas (user_camera_permissions). */
export const GRANTED_VISIBILITY_ROLES: readonly RoleKey[] = ROLE_KEYS.filter(
  (r) => cameraVisibility(r) === "granted",
);
