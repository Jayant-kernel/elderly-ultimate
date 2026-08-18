# Saathi — elderly-ultimate

Daily AI phone companion for elders (Hindi/Hinglish), built from scratch phase by phase.
Every phase has a test gate; nothing moves forward until the gate is green.

| Phase | What | Gate |
|---|---|---|
| 1 | `bridge/` — Twilio media-stream server, DSP, VoicePipeline interface, tone stub | `npm test` green + fake-Twilio harness hears tone |
| 2 | Deploy bridge, real outbound call | you hear the tone on your phone |
| 3 | Ears — Sarvam saaras:v3-realtime WS | live Hinglish transcript in logs |
| 4 | Turn manager | interrupt <500ms, zero false interrupts |
| 5 | Brain — GPT-5.6 Terra + human-speech persona | text replies + emergency drill |
| 6 | Mouth — ElevenLabs v3 | first full call |
| 7 | Memory — Supabase extraction + brief | second call remembers |
| 8 | Family dashboard | |
| 9 | Scheduler + emergency SMS | |
| 10 | Podcasts, capsules, manager dashboard | |
| 11 | Shoot-out + benchmark | |

See `bridge/README.md` for running the bridge.
