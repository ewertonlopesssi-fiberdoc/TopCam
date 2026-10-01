import { Stack, useLocalSearchParams } from "expo-router";
import { VideoView, useVideoPlayer } from "expo-video";
import { StyleSheet, View } from "react-native";
import { listVideos } from "../../lib/videos";

/** Assistir um vídeo baixado (arquivo no celular). */
export default function LocalVideo() {
  const { file, title } = useLocalSearchParams<{ file: string; title?: string }>();
  const v = listVideos().find((x) => x.file === file);
  const player = useVideoPlayer(v ? { uri: v.uri } : null, (p) => p.play());
  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <Stack.Screen options={{ title: title ?? "Vídeo" }} />
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        nativeControls
        fullscreenOptions={{ enable: true }}
      />
    </View>
  );
}
