import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ApiError } from "./api";
import { useAuth } from "./auth";
import type { Camera } from "./cameras";

/** Câmeras do usuário (todas as páginas da API), atualizadas a cada 30 s com a tela aberta. */
export function useCameras() {
  const { api } = useAuth();
  const [cams, setCams] = useState<Camera[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const all: Camera[] = [];
      for (let page = 1; page <= 20; page++) {
        const r = await api.get<{ items: Camera[]; total: number }>(
          `/api/v1/cameras?pageSize=100&page=${page}`,
        );
        all.push(...r.items);
        if (r.items.length < 100 || all.length >= r.total) break;
      }
      setCams(all.filter((c) => c.enabled));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao carregar as câmeras");
    }
  }, [api]);

  useFocusEffect(
    useCallback(() => {
      void load();
      const t = setInterval(load, 30_000);
      return () => clearInterval(t);
    }, [load]),
  );
  return { cams, error, reload: load };
}
