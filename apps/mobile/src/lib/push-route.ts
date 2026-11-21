/** Notificação de alarme → tela do app (sem dependência de React Native). */

/**
 * Para onde o toque na notificação leva: a gravação no horário (quem pode reproduzir) ou o
 * ao vivo. O servidor decide `playback` por usuário.
 */
export function routeForNotification(
  data: Record<string, unknown> | undefined,
):
  | { pathname: "/gravacoes/[id]"; params: { id: string; name: string; t: string } }
  | { pathname: "/camera/[id]"; params: { id: string; name: string } }
  | null {
  if (!data || data.type !== "motion" || typeof data.cameraId !== "string") return null;
  const name = typeof data.cameraName === "string" ? data.cameraName : "";
  if (data.playback === true && typeof data.t === "number")
    return {
      pathname: "/gravacoes/[id]",
      params: { id: data.cameraId, name, t: String(data.t) },
    };
  return { pathname: "/camera/[id]", params: { id: data.cameraId, name } };
}
