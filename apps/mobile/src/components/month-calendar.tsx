import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { monthDays, monthLabel, weekday } from "../lib/time";
import { colors } from "../lib/theme";

/** Calendário do mês: dias com gravação em destaque; os outros ficam apagados. */
export function MonthCalendar({
  month,
  days,
  selected,
  onMonth,
  onSelect,
}: {
  month: string; // AAAA-MM
  days: Set<string>;
  selected: string;
  onMonth: (m: string) => void;
  onSelect: (d: string) => void;
}) {
  const list = monthDays(month);
  const lead = weekday(list[0]!);
  const shift = (n: number) => {
    const [y, m] = month.split("-").map(Number) as [number, number];
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    onMonth(d.toISOString().slice(0, 7));
  };
  return (
    <View style={st.wrap}>
      <View style={st.head}>
        <Pressable onPress={() => shift(-1)} accessibilityLabel="Mês anterior" style={st.nav}>
          <Ionicons name="chevron-back" size={20} color={colors.ink} />
        </Pressable>
        <Text style={st.title}>{monthLabel(month)}</Text>
        <Pressable onPress={() => shift(1)} accessibilityLabel="Próximo mês" style={st.nav}>
          <Ionicons name="chevron-forward" size={20} color={colors.ink} />
        </Pressable>
      </View>
      <View style={st.grid}>
        {["D", "S", "T", "Q", "Q", "S", "S"].map((d, i) => (
          <Text key={i} style={[st.cell, st.wd]}>
            {d}
          </Text>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <View key={`e${i}`} style={st.cell} />
        ))}
        {list.map((d) => {
          const has = days.has(d);
          const sel = d === selected;
          return (
            <Pressable
              key={d}
              disabled={!has}
              onPress={() => onSelect(d)}
              accessibilityRole="button"
              accessibilityLabel={`Dia ${Number(d.slice(8))}${has ? ", com gravação" : ""}`}
              accessibilityState={{ selected: sel, disabled: !has }}
              style={st.cell}
            >
              <View style={[st.day, has && st.has, sel && st.sel]}>
                <Text
                  style={[
                    st.dayText,
                    !has && { color: "#cbd5e1" },
                    (has || sel) && { fontWeight: "700" },
                    sel && { color: "#fff" },
                  ]}
                >
                  {Number(d.slice(8))}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: {
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 12,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  nav: { padding: 6 },
  title: { fontSize: 16, fontWeight: "700", color: colors.ink, textTransform: "capitalize" },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: `${100 / 7}%`, alignItems: "center", paddingVertical: 3 },
  wd: { fontSize: 12, color: colors.muted, textAlign: "center" },
  day: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  has: { backgroundColor: "#eef4ff" },
  sel: { backgroundColor: colors.primary },
  dayText: { fontSize: 14, color: colors.ink },
});
