const MAX_ENTRIES = 500;
const entries = [];
let nextId = 1;

function add(level, account, message, detail) {
  const entry = {
    id: nextId++,
    time: new Date().toISOString(),
    level,
    account: account || null,
    message,
    detail: detail || null,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  return entry;
}

function getLogs(sinceId = 0) {
  if (!sinceId) return [...entries];
  return entries.filter((e) => e.id > sinceId);
}

function clearLogs() {
  entries.length = 0;
}

function getLatestId() {
  return entries.length ? entries[entries.length - 1].id : 0;
}

module.exports = { add, getLogs, clearLogs, getLatestId };
