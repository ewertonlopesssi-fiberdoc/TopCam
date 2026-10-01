import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useAuth } from "../lib/auth";
import { colors } from "../lib/theme";

/** Abertura: confere a sessão guardada e manda para o lugar certo. */
export default function Index() {
  const { user } = useAuth();
  if (user === undefined)
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.primary,
        }}
      >
        <ActivityIndicator color="#fff" size="large" />
      </View>
    );
  if (!user) return <Redirect href="/login" />;
  if (user.mustChangePassword) return <Redirect href="/trocar-senha" />;
  return <Redirect href="/(tabs)" />;
}
