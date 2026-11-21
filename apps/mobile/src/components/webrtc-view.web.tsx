import { createElement, useEffect, useRef, useState } from "react";
import { parseWhepMsg, whepPage, type WhepMsg } from "../lib/whep-page";

/** Versão web (testes): a mesma página num iframe (mesma origem, por srcdoc). */
type TcWindow = Window & { tc?: { mute: (m: boolean) => void; full: () => void } };

export function WebrtcView({
  url,
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
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [initialMuted] = useState(muted);
  const [html] = useState(() => whepPage(url, initialMuted));
  const cb = useRef(onMessage);
  useEffect(() => {
    cb.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame?.contentWindow) return;
      const m = parseWhepMsg(e.data);
      if (m) cb.current(m);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [frame]);
  useEffect(() => {
    (frame?.contentWindow as TcWindow | null | undefined)?.tc?.mute(muted);
  }, [muted, frame]);
  useEffect(() => {
    if (!fullscreenRef) return;
    fullscreenRef.current = () => (frame?.contentWindow as TcWindow | null | undefined)?.tc?.full();
  }, [fullscreenRef, frame]);

  return createElement("iframe", {
    ref: setFrame,
    srcDoc: html,
    title: "ao vivo",
    allow: "autoplay; fullscreen",
    "data-testid": "webrtc-frame",
    style: {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      border: 0,
      background: "#000",
      pointerEvents: "none",
    },
  });
}
