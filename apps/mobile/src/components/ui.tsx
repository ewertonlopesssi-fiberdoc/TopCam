import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { statusOf } from "../lib/cameras";
import { colors, tones } from "../lib/theme";

export function Button({
  label,
  onPress,
  busy,
  disabled,
  variant = "primary",
  icon,
  testID,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
  icon?: keyof typeof Ionicons.glyphMap;
  testID?: string;
}) {
  const off = disabled || busy;
  const fg = variant === "primary" ? "#fff" : variant === "danger" ? colors.danger : colors.ink;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [
        s.btn,
        variant === "primary" ? { backgroundColor: colors.primary } : s.btnSecondary,
        (pressed || off) && { opacity: 0.6 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon && <Ionicons name={icon} size={18} color={fg} />}
          <Text style={[s.btnText, { color: fg }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#94a3b8"
        style={s.input}
        autoCapitalize="none"
        autoCorrect={false}
        {...props}
      />
    </View>
  );
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <View style={s.error} accessibilityRole="alert">
      <Ionicons name="alert-circle" size={18} color={colors.danger} />
      <Text style={s.errorText}>{children}</Text>
    </View>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const st = statusOf(status);
  const t = tones[st.tone];
  return (
    <View style={[s.badge, { backgroundColor: t.bg }]}>
      <View style={[s.dot, { backgroundColor: t.fg }]} />
      <Text style={[s.badgeText, { color: t.fg }]}>{st.label}</Text>
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Center({ children }: { children: React.ReactNode }) {
  return <View style={s.center}>{children}</View>;
}

const s = StyleSheet.create({
  btn: {
    height: 48,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
  },
  btnSecondary: { backgroundColor: "#fff", borderWidth: 1, borderColor: colors.line },
  btnText: { fontSize: 16, fontWeight: "600" },
  label: { fontSize: 14, fontWeight: "500", color: colors.ink },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: "#fff",
  },
  error: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
    backgroundColor: "#fef2f2",
    borderRadius: 10,
    padding: 12,
  },
  errorText: { color: "#991b1b", flex: 1, fontSize: 14 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  badgeText: { fontSize: 12, fontWeight: "600" },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: "hidden",
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
});
