import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors } from "../lib/theme";

/**
 * Horário HH:MM:SS (segundos desde a meia-noite). Cada parte aceita digitação e tem ▲/▼;
 * fica sempre entre 00:00:00 e 23:59:59.
 */

const DAY_S = 86_400;
const PARTS = [
  { key: "hora", unit: 3600, max: 23 },
  { key: "minuto", unit: 60, max: 59 },
  { key: "segundo", unit: 1, max: 59 },
] as const;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function TimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (sec: number) => void;
}) {
  const parts = [Math.floor(value / 3600), Math.floor((value % 3600) / 60), value % 60];
  const step = (unit: number, dir: 1 | -1) =>
    onChange(Math.min(DAY_S - 1, Math.max(0, value + dir * unit)));
  return (
    <View style={st.box}>
      <Text style={st.label}>{label}</Text>
      <View style={st.row}>
        {PARTS.map((p, i) => (
          <View key={p.key} style={st.row}>
            {i > 0 && <Text style={st.sep}>:</Text>}
            <Part
              name={`${label} ${p.key}`}
              value={parts[i]!}
              max={p.max}
              onUp={() => step(p.unit, 1)}
              onDown={() => step(p.unit, -1)}
              onSet={(n) => onChange(value - parts[i]! * p.unit + n * p.unit)}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

function Part({
  name,
  value,
  max,
  onUp,
  onDown,
  onSet,
}: {
  name: string;
  value: number;
  max: number;
  onUp: () => void;
  onDown: () => void;
  onSet: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  function commit() {
    if (draft !== null && /^\d{1,2}$/.test(draft)) onSet(Math.min(max, Number(draft)));
    setDraft(null);
  }
  return (
    <View style={st.part}>
      <Pressable
        onPress={onUp}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`${name} mais`}
      >
        <Ionicons name="chevron-up" size={20} color={colors.primary} />
      </Pressable>
      <TextInput
        style={st.input}
        value={draft ?? pad(value)}
        onChangeText={(t) => setDraft(t.replace(/\D/g, "").slice(0, 2))}
        onFocus={() => setDraft("")}
        onBlur={commit}
        onSubmitEditing={commit}
        keyboardType="number-pad"
        maxLength={2}
        selectTextOnFocus
        accessibilityLabel={name}
      />
      <Pressable
        onPress={onDown}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`${name} menos`}
      >
        <Ionicons name="chevron-down" size={20} color={colors.primary} />
      </Pressable>
    </View>
  );
}

const st = StyleSheet.create({
  box: { flex: 1, alignItems: "center", gap: 4 },
  label: { color: colors.muted, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center" },
  sep: { fontSize: 20, fontWeight: "700", color: colors.ink, marginHorizontal: 1 },
  part: { alignItems: "center" },
  input: {
    width: 36,
    textAlign: "center",
    fontSize: 20,
    fontWeight: "700",
    color: colors.ink,
    fontVariant: ["tabular-nums"],
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 0,
  },
});
