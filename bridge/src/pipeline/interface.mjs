/**
 * VoicePipeline — the ONE contract between telephony (CallBridge) and the AI.
 *
 * Every pipeline (tone stub today, cascade later) must be an EventEmitter with:
 *
 *   events:
 *     ready                                — pipeline is live; CallBridge may greet
 *     audio        (mulawBytes, genId)     — outbound speech, mu-law 8 kHz bytes,
 *                                            tagged with the generation that made it
 *     speech_started                       — elder started talking over us: barge-in
 *     response_done                        — a reply finished; flush tail audio
 *     transcript   ({role, text, seq, at}) — for storage / dashboard
 *     tool_call    ({name, callId, args})  — emergency / transfer / podcast …
 *     error        (Error)
 *     close
 *
 *   methods:
 *     connect(context)                     — open vendor sockets
 *     appendAudio(mulawBytes)              — inbound elder audio, mu-law 8 kHz bytes
 *     createResponse(instructions?)        — ask for a reply (used for greeting)
 *     cancelResponse()                     — abort current reply
 *     sendToolResult(callId, result)
 *     close()
 *
 * Audio contract across this boundary is mu-law 8 kHz bytes in BOTH directions —
 * zero resampling on the main path (Twilio speaks mu-law 8k natively, ElevenLabs
 * emits ulaw_8000, Sarvam accepts 8 kHz). The resamplers in src/audio/ stay off
 * this path; they exist for bulbul/podcast work only.
 *
 * Generation ids exist because cancelling a reply mid-flight (barge-in) must
 * never let a vendor's late flush reach the caller — ElevenLabs' close_context
 * FLUSHES remaining audio rather than discarding it. CallBridge drops every
 * frame of a cancelled generation.
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
