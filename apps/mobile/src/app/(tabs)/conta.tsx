import { router } from "expo-router";
import { useState } from "react";
import { Alert, Linking, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { Button, Card } from "../../components/ui";
import { ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  PUSH_PROBLEM,
  pushSupported,
  registerPush,
  savedPush,
  setPushState,
  usePushState,
} from "../../lib/push";
import { appVersion, brand } from "../../lib/brand";
import { colors } from "../../lib/theme";

/** Alarmes no celular: ligar/desligar e notificação de teste. */
function PushCard() {
  const { api } = useAuth();
  const state = usePushState();
  const [busy, setBusy] = useState(false);
  const on = state?.ok ? state.enabled : savedPush().enabled;
  const problem = state && !state.ok ? PUSH_PROBLEM[state.reason] : null;

  async function toggle(v: boolean) {
    setBusy(true);
    setPushState(await registerPush(api, v));
    setBusy(false);
  }
  async function test() {
    setBusy(true);
    try {
      const r = await api.post<{ sent: number; failed: number; errors: string[] }>(
        "/api/v1/push/test",
      );
      Alert.alert(
        r.sent ? "Enviada" : "Não enviada",
        r.sent
          ? "A notificação de teste deve chegar em alguns segundos."
          : `O serviço de push recusou: ${r.errors[0] ?? "erro desconhecido"}`,
      );
    } catch (e) {
      Alert.alert("Não enviada", e instanceof ApiError ? e.message : "Falha ao enviar o teste.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <View style={[st.row, st.pushRow]}>
        <View style={{ flex: 1 }}>
          <Text style={st.v}>Notificações de alarme</Text>
          <Text style={st.k}>Movimento nas câmeras com alarme ligado, nos horários definidos.</Text>
        </View>
        <Switch
          value={on && !problem}
          disabled={busy || !pushSupported}
          onValueChange={(v) => void toggle(v)}
          accessibilityLabel="Notificações de alarme"
          testID="push-switch"
        />
      </View>
      {problem ? (
        <Text style={[st.k, st.pushNote]} testID="push-problem">
          {problem}
        </Text>
      ) : null}
      {state?.ok && state.enabled ? (
        <View style={st.pushNote}>
          <Button
            label="Enviar notificação de teste"
            variant="secondary"
            icon="notifications"
            busy={busy}
            onPress={() => void test()}
          />
        </View>
      ) : null}
    </Card>
  );
}

export default function Conta() {
  const { user, logout } = useAuth();
  if (!user) return null;
  const rows: [string, string][] = [
    ["Nome", user.name],
    ["E-mail", user.email],
    ["Perfil", user.roleLabel],
    ...(user.tenant ? ([["Cliente", user.tenant.name]] as [string, string][]) : []),
  ];
  return (
    <ScrollView contentContainerStyle={st.wrap}>
      <Card>
        {rows.map(([k, v], i) => (
          <View key={k} style={[st.row, i > 0 && st.line]}>
            <Text style={st.k}>{k}</Text>
            <Text style={st.v} selectable>
              {v}
            </Text>
          </View>
        ))}
      </Card>
      <PushCard />
      <Button
        label="Trocar senha"
        variant="secondary"
        icon="key"
        onPress={() => router.push("/trocar-senha")}
      />
      {brand.supportEmail ? (
        <Button
          label="Falar com o suporte"
          variant="secondary"
          icon="mail"
          onPress={() => void Linking.openURL(`mailto:${brand.supportEmail}`)}
        />
      ) : null}
      <Button
        label="Sair"
        variant="danger"
        icon="log-out"
        testID="logout"
        onPress={() => void logout().then(() => router.replace("/login"))}
      />
      <Text style={st.foot}>
        {brand.name} · versão {appVersion}
        {"\n"}
        {brand.apiUrl.replace(/^https?:\/\//, "")}
      </Text>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  wrap: { padding: 16, gap: 12 },
  row: { paddingHorizontal: 14, paddingVertical: 12, gap: 2 },
  line: { borderTopWidth: 1, borderTopColor: colors.line },
  k: { fontSize: 12, color: colors.muted },
  v: { fontSize: 16, color: colors.ink },
  pushRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  pushNote: { paddingHorizontal: 14, paddingBottom: 12 },
  foot: { textAlign: "center", color: colors.muted, fontSize: 12, marginTop: 8 },
});
