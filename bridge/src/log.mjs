const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let current = LEVELS[(process.env.LOG_LEVEL || "info").trim()] ?? LEVELS.info;

function emit(level, scope, msg, extra) {
  if (LEVELS[level] < current) return;
  const line = { t: new Date().toISOString(), level, scope, msg, ...(extra || {}) };
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + "\n");
}

export function logger(scope) {
  return {
    debug: (msg, extra) => emit("debug", scope, msg, extra),
    info: (msg, extra) => emit("info", scope, msg, extra),
    warn: (msg, extra) => emit("warn", scope, msg, extra),
    error: (msg, extra) => emit("error", scope, msg, extra),
  };
}

export function setLogLevel(level) {
  if (LEVELS[level]) current = LEVELS[level];
}
