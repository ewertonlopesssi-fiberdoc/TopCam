/**
 * Página mínima que toca o ao vivo por WebRTC (WHEP do MediaMTX, o mesmo do painel).
 * Roda dentro de uma WebView no celular (o navegador do sistema tem WebRTC e H.264) ou de um
 * iframe na versão web. Avisa o app por mensagens:
 *   {t:"state", s:"connecting"|"playing"|"error", m?}   {t:"latency", v:segundos}
 * Comandos do app: window.tc.mute(bool) e window.tc.full().
 */

export type WhepMsg =
  { t: "state"; s: "connecting" | "playing" | "error"; m?: string } | { t: "latency"; v: number };

/** Codecs de áudio que o WebRTC entrega (nomes do ffprobe); AAC não está aqui. */
export const WEBRTC_AUDIO = new Set(["opus", "pcm_alaw", "pcm_mulaw", "adpcm_g722", "g722"]);

export function parseWhepMsg(data: unknown): WhepMsg | null {
  try {
    const m = typeof data === "string" ? (JSON.parse(data) as WhepMsg) : (data as WhepMsg);
    return m && (m.t === "state" || m.t === "latency") ? m : null;
  } catch {
    return null;
  }
}

export function whepPage(whepUrl: string, muted: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}</style>
</head><body><video id="v" playsinline autoplay ${muted ? "muted" : ""}></video><script>
(function(){
  var URL_ = ${JSON.stringify(whepUrl).replace(/</g, "\\u003c")};
  var v = document.getElementById("v");
  var sent = "";
  function send(m){
    var s = JSON.stringify(m);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(s);
    else if (window.parent !== window) window.parent.postMessage(s, "*");
  }
  function state(s, m){ if (s === sent && !m) return; sent = s; send({t:"state", s:s, m:m}); }
  var pc = null, done = false;
  function fail(m){ if (done) return; done = true; state("error", String(m||"falha")); try{pc&&pc.close()}catch(e){} }
  window.tc = {
    mute: function(m){ v.muted = !!m; if (!m) v.play().catch(function(){}); },
    full: function(){
      try {
        if (v.requestFullscreen) v.requestFullscreen();
        else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
      } catch(e){}
    }
  };
  v.addEventListener("playing", function(){ if (!done) state("playing"); });
  async function start(){
    state("connecting");
    if (typeof RTCPeerConnection === "undefined") return fail("sem WebRTC");
    pc = new RTCPeerConnection({bundlePolicy:"max-bundle"});
    pc.addTransceiver("video", {direction:"recvonly"});
    pc.addTransceiver("audio", {direction:"recvonly"});
    var ms = new MediaStream();
    pc.ontrack = function(ev){ ms.addTrack(ev.track); if (v.srcObject !== ms) v.srcObject = ms; v.play().catch(function(){}); };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(function(res){
      if (pc.iceGatheringState === "complete") return res();
      var t = setTimeout(res, 1500);
      pc.addEventListener("icegatheringstatechange", function(){
        if (pc.iceGatheringState === "complete"){ clearTimeout(t); res(); }
      });
    });
    var r = await fetch(URL_, {method:"POST", headers:{"content-type":"application/sdp"}, body: pc.localDescription.sdp, credentials:"omit"});
    if (r.status !== 201) return fail("WHEP " + r.status);
    await pc.setRemoteDescription({type:"answer", sdp: await r.text()});
    pc.addEventListener("connectionstatechange", function(){
      if (pc.connectionState === "failed" || pc.connectionState === "closed") fail("WebRTC " + pc.connectionState);
    });
    // Sem imagem em 10 s: o app troca para HLS.
    setTimeout(function(){ if (sent !== "playing") fail("WebRTC sem imagem"); }, 10000);
    setInterval(async function(){
      if (!pc || done) return;
      var st = await pc.getStats(), lat = null;
      st.forEach(function(s){
        if (s.type === "inbound-rtp" && s.kind === "video" && s.estimatedPlayoutTimestamp) {
          var l = (Date.now() + 2208988800000 - s.estimatedPlayoutTimestamp) / 1000;
          if (l > 0 && l < 60) lat = l;
        }
      });
      if (lat !== null) send({t:"latency", v: Math.round(lat * 10) / 10});
    }, 3000);
  }
  start().catch(function(e){ fail(e && e.message); });
})();
</script></body></html>`;
}
