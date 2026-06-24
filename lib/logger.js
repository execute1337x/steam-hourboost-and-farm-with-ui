const eventLog = require("./eventLog");

function timestamp() {
  return new Date().toLocaleTimeString("tr-TR", { hour12: false });
}

function log(username, message, detail) {
  const who = username ? `[${username}]` : "[panel]";
  const extra = detail ? ` — ${detail}` : "";
  console.log(`${timestamp()} ${who} ${message}${extra}`);
  eventLog.add("info", username, message, detail || null);
}

function logError(username, message, detail) {
  const who = username ? `[${username}]` : "[panel]";
  const extra = detail ? ` — ${detail}` : "";
  console.error(`${timestamp()} ${who} HATA: ${message}${extra}`);
  eventLog.add("error", username, message, detail || null);
}

function eresultName(Steam, code) {
  if (!Steam?.EResult) return String(code);
  return Steam.EResult[code] || String(code);
}

module.exports = { log, logError, eresultName };
