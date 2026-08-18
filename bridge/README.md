# bridge — the telephony ↔ AI bridge

Node 20+, single dependency (`ws`). Twilio Media Streams in, PCM16@24k across the
`VoicePipeline` boundary (`src/pipeline/interface.mjs`), μ-law 8k back out.

```
npm install
npm test                       # unit + integration tests (no keys needed)
npm start                      # PORT=8080, PIPELINE=tone
npm run harness                # fake Twilio call → tools/out/heard.wav
node tools/fake-twilio.mjs ws://localhost:8080/media --seconds 4 --barge-at 400
node tools/fake-twilio.mjs ws://localhost:8080/media --speak path/to/caller.wav
```

Layout
- `src/server.mjs` — HTTP `/health`, WS `/media`, one `CallBridge` per call
- `src/call-bridge.mjs` — Twilio protocol, codec/resample, 20 ms pacing, barge-in clear
- `src/audio/` — μ-law codec, FIR resamplers (8k↔24k, 24k→16k), PCM helpers
- `src/pipeline/` — `interface.mjs` (the contract), `tone-pipeline.mjs` (Phase 1 stub), `index.mjs` (factory by `PIPELINE` env)
- `tools/fake-twilio.mjs` — local phone-call simulator

Phase log
- **Phase 1 ✅** — skeleton, DSP, tone stub, harness. 14 tests green; harness hears chime, barge-in clear <25 ms.
