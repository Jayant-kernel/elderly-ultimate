/** TwiML builders. Rule: every TwiML response ships with HTTP 200 — Twilio
 * discards non-2xx bodies and hangs up silently; the status code is for us,
 * the caller only ever hears the body. (Enforced at the route, built here.)
 */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * <Connect><Stream> with <Parameter> NOUNS — never query strings: Twilio
 * silently strips ?query from <Stream> URLs, which reads as a mystery
 * auth failure an hour into debugging. Baked in as a thrown error.
 */
export function streamTwiml({ wsUrl, params = {} }) {
  if (String(wsUrl).includes("?")) throw new Error("Stream URL must not carry a query string — use <Parameter> nouns");
  const parameters = Object.entries(params)
    .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${escapeXml(wsUrl)}">${parameters}</Stream></Connect></Response>`;
}

export function apologyTwiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Say voice="Polly.Aditi" language="en-IN">${escapeXml(message)}</Say><Hangup/></Response>`;
}
