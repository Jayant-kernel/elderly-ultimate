import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { config } from "./config.mjs";
import { logger, setLogLevel } from "./log.mjs";
import { createPipeline } from "./pipeline/index.mjs";
import { CallBridge } from "./call-bridge.mjs";
import { signToken, verifyToken } from "./token.mjs";
import { streamTwiml, apologyTwiml } from "./twiml.mjs";
import { verifyTwilioWebhook } from "./webhook-auth.mjs";

setLogLevel(config.logLevel);
const log = logger("server");

const APOLOGY_UNVERIFIED = "Sorry, this call could not be verified.";
const APOLOGY_VOICEMAIL = "Namaste, this is Saathi calling. We will try again a little later.";

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export function createServer(opts = {}) {
  const cfg = { ...config, ...(opts.configOverrides || {}) };
  const pipelineKind = opts.pipeline || cfg.pipeline;
  const calls = new Map();
  const vendors = {}; // per-vendor last error, surfaced on /health for silent-death diagnosis
  const reportVendor = (name, err) => {
    vendors[name] = { lastError: err == null ? null : String(err.message || err), at: new Date().toISOString() };
  };

  /**
   * TwiML must ALWAYS ship with 200: Twilio treats any non-2xx as an
   * application error, discards the body, and hangs up without playing a
   * word — a spoken apology on a 403 produces exactly the silent hangup it
   * was meant to prevent.
   */
  function buildTwiml(req, url, form) {
    if (!cfg.tokenSigningSecret) {
      log.error("twiml requested but TOKEN_SIGNING_SECRET not set");
      return apologyTwiml(APOLOGY_UNVERIFIED);
    }
    if (cfg.twilioAuthToken) {
      const check = verifyTwilioWebhook({
        headers: req.headers,
        pathWithQuery: url.pathname + url.search,
        form,
        authToken: cfg.twilioAuthToken,
        publicUrl: cfg.publicUrl,
      });
      if (!check.ok) {
        log.error("twiml signature check failed", { tried: check.tried, hadSignature: check.hadSignature });
        return apologyTwiml(APOLOGY_UNVERIFIED);
      }
    } else if (cfg.isProduction) {
      log.error("twiml requested but TWILIO_AUTH_TOKEN not set — refusing in production");
      return apologyTwiml(APOLOGY_UNVERIFIED);
    }

    const attemptId = url.searchParams.get("attempt");
    const verified = verifyToken(cfg.tokenSigningSecret, "attempt", url.searchParams.get("token"));
    if (!verified || verified.sub !== attemptId) {
      log.error("bad attempt token", { attemptId });
      return apologyTwiml(APOLOGY_UNVERIFIED);
    }

    // Twilio's answering-machine detection: Saathi holding a warm conversation
    // with a voicemail greeting would be both useless and slightly grim.
    if (form.AnsweredBy && form.AnsweredBy.startsWith("machine")) {
      log.info("reached voicemail", { attemptId, answeredBy: form.AnsweredBy });
      return apologyTwiml(APOLOGY_VOICEMAIL);
    }

    try {
      const params = { attempt: attemptId, token: signToken(cfg.tokenSigningSecret, "call", attemptId) };
      const greeting = url.searchParams.get("greeting");
      if (greeting) params.greeting = greeting;
      const wsUrl = cfg.publicUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/media";
      log.info("twiml issued", { attemptId, answeredBy: form.AnsweredBy || null });
      return streamTwiml({ wsUrl, params });
    } catch (e) {
      log.error("could not build stream twiml", { err: String(e.message) });
      return apologyTwiml("Sorry, we cannot connect this call right now.");
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
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
      if (url.pathname === "/twiml" && req.method === "POST") {
        const raw = await readBody(req);
        const form = {};
        for (const [k, v] of new URLSearchParams(raw)) form[k] = v;
        res.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
        res.end(buildTwiml(req, url, form));
        return;
      }
      if (url.pathname === "/status" && req.method === "POST") {
        const raw = await readBody(req);
        const form = {};
        for (const [k, v] of new URLSearchParams(raw)) form[k] = v;
        log.info("status callback", {
          callSid: form.CallSid,
          status: form.CallStatus,
          answeredBy: form.AnsweredBy || null,
          durationSec: form.CallDuration ? Number(form.CallDuration) : null,
        });
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      log.error("http handler error", { path: url.pathname, err: String(e && e.message ? e.message : e) });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/media") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  // Gate the media stream on the call-domain token carried as a <Parameter>
  // noun. Local dev (no secret) is permissive so the fake-Twilio harness works.
  const validateStart = (customParameters) => {
    if (!cfg.tokenSigningSecret) return true;
    const payload = verifyToken(cfg.tokenSigningSecret, "call", customParameters.token || null);
    return Boolean(payload && payload.sub && payload.sub === customParameters.attempt);
  };

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
    const bridge = new CallBridge({ ws, pipeline, callId, validateStart, onEnd: () => calls.delete(callId) });
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
