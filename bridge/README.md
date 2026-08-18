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
- `src/server.mjs` — HTTP `/health` (incl. per-vendor lastError), WS `/media`, one `CallBridge` per call
- `src/call-bridge.mjs` — Twilio protocol, 20 ms pacing, barge-in clear, generation-id gating
- `src/audio/` — μ-law codec, FIR resamplers, PCM helpers — **off the main path** (bulbul/podcast only)
- `src/pipeline/` — `interface.mjs` (the contract), `tone-pipeline.mjs` (Phase 1 stub), `index.mjs` (factory by `PIPELINE` env)
- `tools/fake-twilio.mjs` — local phone-call simulator

Phase log
- **Phase 1 ✅** — skeleton, DSP, tone stub, harness. 14 tests green; harness hears chime, barge-in clear <25 ms.
- **Phase 1.5 ✅** — realigned to the v2 (post-adversarial-review) contract: μ-law 8 kHz end-to-end, zero main-path resampling, generation-id gating against late vendor flushes, `/health` vendor-error registry, transcript `{role,text,seq,at}`.
