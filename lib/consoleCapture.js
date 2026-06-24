const { EventEmitter } = require("events");

const MAX_LINES = 2000;
const lines = [];
const bus = new EventEmitter();
let nextId = 1;
let installed = false;
let skipStreamCapture = false;

function pushLine(stream, text) {
  const entry = {
    id: nextId++,
    time: new Date().toISOString(),
    stream,
    text,
  };
  lines.push(entry);
  if (lines.length > MAX_LINES) {
    lines.splice(0, lines.length - MAX_LINES);
  }
  bus.emit("line", entry);
  return entry;
}

function pushChunk(stream, chunk) {
  const text = String(chunk);
  const parts = text.split(/\r?\n/);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i === parts.length - 1 && text.endsWith("\n") === false && part === "") {
      continue;
    }
    if (part.length === 0 && i < parts.length - 1) {
      pushLine(stream, "");
      continue;
    }
    if (part.length > 0 || i < parts.length - 1) {
      pushLine(stream, part);
    }
  }
}

function install() {
  if (installed) return;
  installed = true;

  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = (...args) => {
    pushLine("out", args.map(formatArg).join(" "));
    skipStreamCapture = true;
    try {
      origLog.apply(console, args);
    } finally {
      skipStreamCapture = false;
    }
  };

  console.error = (...args) => {
    pushLine("err", args.map(formatArg).join(" "));
    skipStreamCapture = true;
    try {
      origError.apply(console, args);
    } finally {
      skipStreamCapture = false;
    }
  };

  console.warn = (...args) => {
    pushLine("err", args.map(formatArg).join(" "));
    skipStreamCapture = true;
    try {
      origWarn.apply(console, args);
    } finally {
      skipStreamCapture = false;
    }
  };

  wrapStream(process.stdout, "out");
  wrapStream(process.stderr, "err");
}

function formatArg(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function wrapStream(stream, name) {
  const original = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    if (
      !skipStreamCapture &&
      (typeof chunk === "string" || Buffer.isBuffer(chunk))
    ) {
      pushChunk(name, chunk.toString());
    }
    return original(chunk, encoding, callback);
  };
}

function getLines(sinceId = 0) {
  if (!sinceId) return [...lines];
  return lines.filter((l) => l.id > sinceId);
}

function getLatestId() {
  return lines.length ? lines[lines.length - 1].id : 0;
}

function clearLines() {
  lines.length = 0;
  bus.emit("clear");
}

function onLine(listener) {
  bus.on("line", listener);
  return () => bus.off("line", listener);
}

function onClear(listener) {
  bus.on("clear", listener);
  return () => bus.off("clear", listener);
}

module.exports = {
  install,
  getLines,
  getLatestId,
  clearLines,
  onLine,
  onClear,
};
