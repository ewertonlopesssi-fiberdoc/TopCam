import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { useAuth } from "../lib/auth";
import { registerPush, savedPush, setPushState } from "../lib/push";
import { routeForNotification } from "../lib/push-route";

/**
 * Com o usuário logado: registra este celular para os alarmes (uma vez por abertura) e abre
 * a tela certa ao tocar numa notificação (com o app aberto, em segundo plano ou fechado).
 */
export function PushBridge() {
  const { api, user } = useAuth();
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    void registerPush(api, savedPush().enabled).then(setPushState);
  }, [api, userId]);

  const last = Notifications.useLastNotificationResponse();
  const handled = useRef(new Set<string>());
  useEffect(() => {
    if (!last || !userId) return;
    const id = last.notification.request.identifier;
    if (handled.current.has(id)) return;
    handled.current.add(id);
    const to = routeForNotification(last.notification.request.content.data);
    Notifications.clearLastNotificationResponse();
    if (to) router.push(to);
  }, [last, userId]);
  return null;
}
