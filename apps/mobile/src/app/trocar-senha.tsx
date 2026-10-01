import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { Button, ErrorText, Field } from "../components/ui";
import { ApiError, type User } from "../lib/api";
import { useAuth } from "../lib/auth";
import { passwordProblem } from "../lib/cameras";
import { colors } from "../lib/theme";

/** Troca de senha: obrigatória no primeiro acesso; também aberta pela tela Conta. */
export default function TrocarSenha() {
  const { api, user, setUser, logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const forced = !!user?.mustChangePassword;

  async function submit() {
    setError(null);
    const p = passwordProblem(next);
    if (p) return setError(p);
    if (next !== confirm) return setError("A confirmação não confere com a nova senha.");
    setBusy(true);
    try {
      const r = await api.post<{ user: User }>("/api/v1/auth/change-password", {
        currentPassword: current,
        newPassword: next,
      });
      setUser(r.user);
      if (forced) router.replace("/(tabs)");
      else setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao trocar a senha");
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <ScrollView contentContainerStyle={st.wrap}>
        <Text style={st.ok}>
          Senha trocada. As outras sessões abertas (outros celulares e o painel) foram encerradas.
        </Text>
        <Button label="Voltar" onPress={() => router.back()} />
      </ScrollView>
    );

  return (
    <ScrollView contentContainerStyle={st.wrap} keyboardShouldPersistTaps="handled">
      {forced && (
        <Text style={st.info}>Primeiro acesso: crie uma senha só sua para continuar.</Text>
      )}
      <Field
        label={forced ? "Senha atual (temporária)" : "Senha atual"}
        value={current}
        onChangeText={setCurrent}
        secureTextEntry
        testID="pw-current"
      />
      <Field
        label="Nova senha"
        value={next}
        onChangeText={setNext}
        secureTextEntry
        testID="pw-new"
      />
      <Field
        label="Confirme a nova senha"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        testID="pw-confirm"
      />
      <Text style={st.hint}>
        Mínimo de 8 caracteres, com letra maiúscula, letra minúscula e número.
      </Text>
      <ErrorText>{error}</ErrorText>
      <Button
        label="Salvar nova senha"
        onPress={submit}
        busy={busy}
        disabled={!current || !next || !confirm}
        testID="pw-submit"
      />
      {forced && (
        <Button
          label="Sair"
          variant="secondary"
          onPress={() => void logout().then(() => router.replace("/login"))}
        />
      )}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  wrap: { padding: 20, gap: 16 },
  info: { backgroundColor: "#eef4ff", color: colors.ink, padding: 12, borderRadius: 10 },
  hint: { color: colors.muted, fontSize: 13 },
  ok: { color: colors.ink, fontSize: 16 },
});
