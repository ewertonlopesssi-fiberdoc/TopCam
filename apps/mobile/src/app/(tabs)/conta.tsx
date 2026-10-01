import { router } from "expo-router";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { Button, Card } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { appVersion, brand } from "../../lib/brand";
import { colors } from "../../lib/theme";

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
  foot: { textAlign: "center", color: colors.muted, fontSize: 12, marginTop: 8 },
});
