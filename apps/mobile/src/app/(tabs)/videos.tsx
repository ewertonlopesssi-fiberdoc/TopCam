import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import * as MediaLibrary from "expo-media-library/legacy";
import * as Sharing from "expo-sharing";
import { useCallback, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Center } from "../../components/ui";
import { colors } from "../../lib/theme";
import { clock, whenLabel } from "../../lib/time";
import { deleteVideo, listVideos, videosSupported } from "../../lib/videos";

/** Trechos baixados pelo app (ficam no celular): assistir, compartilhar, salvar na galeria, apagar. */
export default function Videos() {
  const [items, setItems] = useState(() => listVideos());
  useFocusEffect(useCallback(() => setItems(listVideos()), []));

  if (!videosSupported)
    return (
      <Center>
        <Text style={{ color: colors.muted }}>Os vídeos baixados ficam no app do celular.</Text>
      </Center>
    );

  return (
    <FlatList
      data={items}
      keyExtractor={(x) => x.file}
      contentContainerStyle={{ padding: 16, gap: 10, flexGrow: 1 }}
      ListEmptyComponent={
        <Center>
          <Ionicons name="film-outline" size={36} color={colors.muted} />
          <Text style={{ color: colors.muted, textAlign: "center" }}>
            Nenhum vídeo baixado. Nas gravações de uma câmera, use &quot;Baixar trecho&quot;.
          </Text>
        </Center>
      }
      renderItem={({ item }) => (
        <View style={st.row}>
          <Pressable
            style={st.main}
            accessibilityRole="button"
            accessibilityLabel={`Assistir ${item.cameraName}`}
            onPress={() =>
              router.push({
                pathname: "/video/[file]",
                params: { file: item.file, title: item.cameraName },
              })
            }
          >
            <View style={st.icon}>
              <Ionicons name="play" size={22} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={st.name} numberOfLines={1}>
                {item.cameraName}
              </Text>
              <Text style={st.meta}>
                {whenLabel(item.start)} · {Math.round(item.seconds / 60)} min · das{" "}
                {clock(item.start, false)} às {clock(item.start + item.seconds * 1000, false)}
              </Text>
              <Text style={st.meta}>{(item.size / 1048576).toFixed(1).replace(".", ",")} MB</Text>
            </View>
          </Pressable>
          <View style={st.actions}>
            <Act
              icon="share-social"
              label="Compartilhar"
              onPress={() => void Sharing.shareAsync(item.uri, { mimeType: "video/mp4" })}
            />
            <Act
              icon="images"
              label="Salvar na galeria"
              onPress={async () => {
                const p = await MediaLibrary.requestPermissionsAsync(true);
                if (!p.granted)
                  return Alert.alert("Sem permissão", "Permita o acesso às fotos e vídeos.");
                await MediaLibrary.saveToLibraryAsync(item.uri);
                Alert.alert("Pronto", "O vídeo foi salvo na galeria.");
              }}
            />
            <Act
              icon="trash"
              label="Apagar"
              danger
              onPress={() =>
                Alert.alert(
                  "Apagar vídeo",
                  "O vídeo sai deste celular. A gravação no servidor continua.",
                  [
                    { text: "Cancelar", style: "cancel" },
                    {
                      text: "Apagar",
                      style: "destructive",
                      onPress: () => {
                        deleteVideo(item.file);
                        setItems(listVideos());
                      },
                    },
                  ],
                )
              }
            />
          </View>
        </View>
      )}
    />
  );
}

function Act({
  icon,
  label,
  onPress,
  danger,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={st.act}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={18} color={danger ? colors.danger : colors.ink} />
      <Text style={[st.actText, danger && { color: colors.danger }]}>{label}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  row: {
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: "hidden",
  },
  main: { flexDirection: "row", gap: 12, padding: 12, alignItems: "center" },
  icon: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { fontSize: 15, fontWeight: "600", color: colors.ink },
  meta: { fontSize: 12, color: colors.muted },
  actions: { flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.line },
  act: { flex: 1, alignItems: "center", gap: 2, paddingVertical: 8 },
  actText: { fontSize: 11, color: colors.ink },
});
