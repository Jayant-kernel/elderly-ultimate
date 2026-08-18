import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { config } from "./config.mjs";
import { logger, setLogLevel } from "./log.mjs";
import { createPipeline } from "./pipeline/index.mjs";
import { CallBridge } from "./call-bridge.mjs";

setLogLevel(config.logLevel);
const log = logger("server");

export function createServer(opts = {}) {
  const pipelineKind = opts.pipeline || config.pipeline;
  const calls = new Map();
  const vendors = {}; // per-vendor last error, surfaced on /health for silent-death diagnosis
  const reportVendor = (name, err) => {
    vendors[name] = { lastError: err == null ? null : String(err.message || err), at: new Date().toISOString() };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        pipeline: pipelineKind,
        activeCalls: calls.size,
        uptimeSec: Math.round(process.uptime()),
        vendors,
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/media") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    const callId = randomUUID().slice(0, 8);
    log.info("ws connection", { callId, activeCalls: calls.size + 1 });
    let pipeline;
    try {
      pipeline = createPipeline(pipelineKind, { callId, reportVendor });
    } catch (e) {
      log.error("pipeline create failed", { callId, err: String(e.message) });
      ws.close();
      return;
    }
    const bridge = new CallBridge({ ws, pipeline, callId, onEnd: () => calls.delete(callId) });
    calls.set(callId, bridge);
  });

  const shutdown = () => {
    for (const b of calls.values()) b.end("server_shutdown");
    return new Promise((resolve) => server.close(() => resolve()));
  };

  return { server, wss, calls, shutdown };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { server, shutdown, calls } = createServer();
  server.listen(config.port, () => log.info("listening", { port: config.port, pipeline: config.pipeline }));
  const stop = () => {
    log.info("shutting down", { activeCalls: calls.size });
    shutdown().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
