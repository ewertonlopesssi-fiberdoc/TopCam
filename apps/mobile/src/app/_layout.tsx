import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../lib/auth";
import { colors } from "../lib/theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.dark },
            headerTintColor: "#fff",
            headerTitleStyle: { fontWeight: "600" },
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="trocar-senha" options={{ title: "Trocar senha" }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="camera/[id]" options={{ title: "Ao vivo" }} />
          <Stack.Screen name="gravacoes/[id]" options={{ title: "Gravações" }} />
          <Stack.Screen name="video/[file]" options={{ title: "Vídeo" }} />
        </Stack>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
