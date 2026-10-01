import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Button, ErrorText, Field } from "../components/ui";
import { useAuth } from "../lib/auth";
import { appVersion, brand } from "../lib/brand";
import { colors } from "../lib/theme";

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const u = await login(email.trim(), password);
      router.replace(u.mustChangePassword ? "/trocar-senha" : "/(tabs)");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.primary }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={st.wrap} keyboardShouldPersistTaps="handled">
          <View style={st.head}>
            <View style={st.logo}>
              <Ionicons name="shield-checkmark" size={36} color={colors.primary} />
            </View>
            <Text style={st.title}>{brand.name}</Text>
            <Text style={st.tagline}>{brand.tagline}</Text>
          </View>
          <View style={st.card}>
            <Field
              label="E-mail"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoComplete="email"
              textContentType="username"
              testID="login-email"
            />
            <Field
              label="Senha"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="password"
              textContentType="password"
              onSubmitEditing={submit}
              testID="login-password"
            />
            <ErrorText>{error}</ErrorText>
            <Button
              label="Entrar"
              onPress={submit}
              busy={busy}
              disabled={!email.trim() || !password}
              testID="login-submit"
            />
          </View>
          <Text style={st.foot}>Versão {appVersion}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: "center", padding: 20, gap: 24 },
  head: { alignItems: "center", gap: 6 },
  logo: {
    width: 68,
    height: 68,
    borderRadius: 18,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  title: { color: "#fff", fontSize: 28, fontWeight: "700" },
  tagline: { color: "#dbe7ff", fontSize: 14 },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 20, gap: 16 },
  foot: { color: "#dbe7ff", textAlign: "center", fontSize: 12 },
});
