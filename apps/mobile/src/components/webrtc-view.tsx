import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { parseWhepMsg, whepPage, type WhepMsg } from "../lib/whep-page";

/**
 * Ao vivo por WebRTC numa WebView (o navegador do sistema faz o WebRTC e decodifica o H.264).
 * Sem toque: o toque fica para a camada do LivePlayer por cima.
 */
export function WebrtcView({
  url,
  baseUrl,
  muted,
  onMessage,
  fullscreenRef,
}: {
  url: string;
  baseUrl: string;
  muted: boolean;
  onMessage: (m: WhepMsg) => void;
  fullscreenRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const web = useRef<WebView>(null);
  // A página é montada uma vez por endereço; o som muda por comando, sem recarregar.
  const [initialMuted] = useState(muted);
  const [html] = useState(() => whepPage(url, initialMuted));

  useEffect(() => {
    web.current?.injectJavaScript(
      `window.tc && window.tc.mute(${muted ? "true" : "false"}); true;`,
    );
  }, [muted]);
  useEffect(() => {
    if (!fullscreenRef) return;
    fullscreenRef.current = () =>
      web.current?.injectJavaScript("window.tc && window.tc.full(); true;");
  }, [fullscreenRef]);

  return (
    <View style={st.fill} pointerEvents="none">
      <WebView
        ref={web}
        source={{ html, baseUrl }}
        originWhitelist={["*"]}
        style={st.web}
        containerStyle={st.web}
        javaScriptEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsFullscreenVideo
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        setSupportMultipleWindows={false}
        onMessage={(e) => {
          const m = parseWhepMsg(e.nativeEvent.data);
          if (m) onMessage(m);
        }}
        onError={() => onMessage({ t: "state", s: "error", m: "WebView" })}
      />
    </View>
  );
}

const st = StyleSheet.create({
  fill: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  web: { flex: 1, backgroundColor: "#000" },
});
