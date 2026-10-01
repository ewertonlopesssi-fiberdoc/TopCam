// Versão web do app, só para testes automáticos (Playwright) contra o laboratório.
//
//   API_URL=http://localhost:8099 npx expo export --platform web
//   TARGET=http://localhost node scripts/web-preview.mjs      # porta 8099
//
// Serve dist/ e repassa /api, /live e /playback ao gateway (mesma origem: sem CORS).
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 8099);
const TARGET = new URL(process.env.TARGET ?? "http://localhost");
const DIST = join(import.meta.dirname, "..", "dist");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".ttf": "font/ttf",
};

http
  .createServer((req, res) => {
    if (/^\/(api|live|playback)\//.test(req.url)) {
      const p = http.request(
        {
          hostname: TARGET.hostname,
          port: TARGET.port || 80,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: TARGET.host },
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      p.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(p);
      return;
    }
    let file = normalize(join(DIST, decodeURIComponent(req.url.split("?")[0])));
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory())
      file = join(DIST, "index.html"); // rotas do app (SPA)
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log(`app web em http://localhost:${PORT} → ${TARGET.origin}`));
