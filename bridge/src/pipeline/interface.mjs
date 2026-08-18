/**
 * VoicePipeline — the ONE contract between telephony (CallBridge) and the AI.
 *
 * Every pipeline (tone stub today, cascade later) must be an EventEmitter with:
 *
 *   events:
 *     ready                              — pipeline is live; CallBridge may greet
 *     audio        (base64 PCM16 @ 24 kHz) — outbound speech chunk
 *     speech_started                     — elder started talking over us: barge-in
 *     response_done                      — a reply finished; flush tail audio
 *     transcript   ({role, text, itemId}) — for storage / dashboard
 *     tool_call    ({name, callId, args}) — emergency / transfer / podcast …
 *     error        (Error)
 *     close
 *
 *   methods:
 *     connect(sessionConfig)             — open vendor sockets
 *     appendAudio(pcm16Int16Array24k)    — inbound elder audio, PCM16 @ 24 kHz
 *     createResponse(instructions?)      — ask for a reply (used for greeting)
 *     cancelResponse()                   — abort current reply
 *     sendToolResult(callId, result)
 *     close()
 *
 * Audio contract across this boundary is PCM16 @ 24 kHz in BOTH directions.
 * CallBridge owns all telephony codec work; pipelines never see μ-law.
 */
export const PIPELINE_EVENTS = [
  "ready", "audio", "speech_started", "response_done", "transcript", "tool_call", "error", "close",
];
export const PIPELINE_METHODS = [
  "connect", "appendAudio", "createResponse", "cancelResponse", "sendToolResult", "close",
];

export function assertPipeline(p) {
  for (const m of PIPELINE_METHODS) {
    if (typeof p[m] !== "function") throw new Error(`Pipeline missing method ${m}`);
  }
  if (typeof p.on !== "function") throw new Error("Pipeline must be an EventEmitter");
}
