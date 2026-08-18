# bridge — the telephony ↔ AI bridge

Node 20+, single dependency (`ws`). Twilio Media Streams in, **μ-law 8 kHz bytes
across the `VoicePipeline` boundary in both directions** (`src/pipeline/interface.mjs`)
— zero resampling on the main path. Outbound audio is tagged with a generation id;
frames of a barge-in-cancelled generation are dropped, never forwarded.

```
npm install
npm test                       # unit + integration tests (no keys needed)
npm start                      # PORT=8080, PIPELINE=tone
npm run harness                # fake Twilio call → tools/out/heard.wav
node tools/fake-twilio.mjs ws://localhost:8080/media --seconds 4 --barge-at 400
node tools/fake-twilio.mjs ws://localhost:8080/media --speak path/to/caller.wav
```

Layout
- `src/server.mjs` — HTTP `/health` (incl. per-vendor lastError), `POST /twiml`, `POST /status`, WS `/media`, one `CallBridge` per call
- `src/call-bridge.mjs` — Twilio protocol, 20 ms pacing, barge-in clear, generation-id gating, start-token gate
- `src/token.mjs` — domain-separated HMAC tokens: attempt (30 m) vs call (90 m), never interchangeable
- `src/twiml.mjs` — TwiML builders; `<Parameter>` nouns only (Twilio strips `?query` from Stream URLs)
- `src/webhook-auth.mjs` — Twilio signature check, multi-candidate URLs (proxies rewrite host/proto)
- `src/audio/` — μ-law codec, FIR resamplers, PCM helpers — **off the main path** (bulbul/podcast only)
- `src/pipeline/` — `interface.mjs` (the contract), `tone-pipeline.mjs` (Phase 1 stub), `index.mjs` (factory by `PIPELINE` env)
- `tools/fake-twilio.mjs` — local phone-call simulator
- `tools/dial.mjs` — force-dial one outbound call through the deployed bridge

Deploy (Railway — a NEW project, never inside production's)
1. New Railway project → deploy from GitHub, root directory `bridge/`, region **Southeast Asia (Singapore)** if your plan offers it — closest to Indian phones, shaves a network hop off every frame.
2. Set env: `PIPELINE=tone`, `PUBLIC_URL=https://<railway-domain>`, `TOKEN_SIGNING_SECRET=<long random>`, `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER`. (`PORT` is injected by Railway.)
3. `curl https://<domain>/health` → `{"ok":true,...}`.
4. From your machine, same env in the shell: `node tools/dial.mjs --to +91XXXXXXXXXX` (must be an SMS-verified number on the trial). Trial calls play Twilio's "press any key" gate first — press a key, then the chime.
5. Shared-trial rules: outbound only; never touch any number's inbound webhook.

Test-gate for Phase 2: phone rings → key press → chime heard → `/status` callback logged with `completed`.

Phase log
- **Phase 1 ✅** — skeleton, DSP, tone stub, harness. 14 tests green; harness hears chime, barge-in clear <25 ms.
- **Phase 1.5 ✅** — realigned to the v2 (post-adversarial-review) contract: μ-law 8 kHz end-to-end, zero main-path resampling, generation-id gating against late vendor flushes, `/health` vendor-error registry, transcript `{role,text,seq,at}`.
- **Phase 2 (code ✅, live gate pending deploy)** — `/twiml` (always-200, Parameter nouns, tolerant signature check, voicemail apology), `/status`, domain-separated HMAC tokens gating both the TwiML URL and the media stream, `dial.mjs` force-dial. 24 tests green.
