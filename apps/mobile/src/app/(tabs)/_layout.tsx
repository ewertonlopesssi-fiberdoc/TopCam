import { Ionicons } from "@expo/vector-icons";
import { Redirect } from "expo-router";
import Tabs from "expo-router/js-tabs";
import { PushBridge } from "../../components/push-bridge";
import { useAuth } from "../../lib/auth";
import { brand } from "../../lib/brand";
import { colors } from "../../lib/theme";

export default function TabsLayout() {
  const { user } = useAuth();
  if (user === null) return <Redirect href="/login" />;
  if (user?.mustChangePassword) return <Redirect href="/trocar-senha" />;
  return (
    <>
      <PushBridge />
      <Tabs
        screenOptions={{
          headerStyle: { backgroundColor: colors.dark },
          headerTintColor: "#fff",
          tabBarActiveTintColor: colors.primary,
          sceneStyle: { backgroundColor: colors.bg },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Câmeras",
            headerTitle: brand.name,
            tabBarIcon: ({ color, size }) => <Ionicons name="videocam" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="mosaico"
          options={{
            title: "Mosaico",
            tabBarIcon: ({ color, size }) => <Ionicons name="grid" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="alarmes"
          options={{
            title: "Alarmes",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="notifications" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="videos"
          options={{
            title: "Meus vídeos",
            tabBarIcon: ({ color, size }) => <Ionicons name="film" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="conta"
          options={{
            title: "Conta",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="person-circle" color={color} size={size} />
            ),
          }}
        />
      </Tabs>
    </>
  );
}
