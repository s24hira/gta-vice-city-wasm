import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function serveGameArchivePlugin() {
  const handler = (req, res, next) => {
    const url = req.url?.split("?")[0];
    if (url === "/game.tar.gz" || url === "/gta-vice-city-wasm/game.tar.gz") {
      const archivePath = path.resolve(__dirname, "game.tar.gz");
      if (fs.existsSync(archivePath)) {
        const stat = fs.statSync(archivePath);
        res.writeHead(200, {
          "Content-Type": "application/gzip",
          "Content-Length": stat.size,
          "Accept-Ranges": "bytes",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(archivePath).pipe(res);
        return;
      }
    }
    next();
  };

  return {
    name: "serve-game-archive",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  base: "/gta-vice-city-wasm/",
  plugins: [serveGameArchivePlugin()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    target: "esnext",
  },
});
