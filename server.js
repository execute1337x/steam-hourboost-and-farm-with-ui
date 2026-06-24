require("./lib/consoleCapture").install();

const express = require("express");
const session = require("express-session");
const path = require("path");
const { AccountManager } = require("./lib/accountManager");
const { verifyLogin, getSessionSecret, getCredentials } = require("./lib/auth");
const { log } = require("./lib/logger");
const consoleCapture = require("./lib/consoleCapture");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");

const app = express();
const manager = new AccountManager();

app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    secret: getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
    },
  })
);

function isAuthenticated(req) {
  return Boolean(req.session?.authenticated);
}

function isPublicRoute(req) {
  return req.path === "/login" || req.path === "/api/auth/login";
}

app.get("/login", (req, res) => {
  if (isAuthenticated(req)) {
    return res.redirect("/");
  }
  res.sendFile(path.join(PUBLIC_DIR, "login.html"));
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!verifyLogin(username, password)) {
    return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı" });
  }
  req.session.authenticated = true;
  req.session.username = String(username).trim();
  res.json({ ok: true, username: req.session.username });
});

app.use((req, res, next) => {
  if (isPublicRoute(req)) {
    return next();
  }

  if (!isAuthenticated(req)) {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Giriş gerekli" });
    }
    return res.redirect("/login");
  }

  next();
});

app.get("/api/auth/me", (req, res) => {
  res.json({
    authenticated: isAuthenticated(req),
    username: req.session?.username || null,
  });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.use(express.static(PUBLIC_DIR, { index: false }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/api/accounts", (_req, res) => {
  res.json({ accounts: manager.getAccountsForClient() });
});

app.post("/api/accounts", (req, res) => {
  try {
    const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts : [];
    const saved = manager.saveAccounts(accounts);
    res.json({
      ok: true,
      accounts: saved.map((acc) => ({
        id: acc.id,
        username: acc.username,
        password: acc.password,
        games: acc.games,
        sharedSecret: acc.sharedSecret || "",
        persona: acc.persona,
        running: manager.farmers.has(acc.id),
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/status", (_req, res) => {
  res.json(manager.getAllStatus());
});

app.get("/api/console", (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  res.json({
    lines: consoleCapture.getLines(since),
    latestId: consoleCapture.getLatestId(),
  });
});

app.get("/api/console/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const since = parseInt(req.query.since, 10) || 0;
  for (const line of consoleCapture.getLines(since)) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }

  const offLine = consoleCapture.onLine((line) => {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  });
  const offClear = consoleCapture.onClear(() => {
    res.write("event: clear\ndata: {}\n\n");
  });

  req.on("close", () => {
    offLine();
    offClear();
  });
});

app.post("/api/console/clear", (_req, res) => {
  consoleCapture.clearLines();
  console.log("[panel] Konsol temizlendi");
  res.json({ ok: true });
});

app.post("/api/accounts/:id/start", (req, res) => {
  try {
    const snapshot = manager.startAccount(req.params.id);
    res.json({ ok: true, account: snapshot });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/accounts/:id/stop", (req, res) => {
  try {
    const snapshot = manager.stopAccount(req.params.id);
    res.json({ ok: true, account: snapshot });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/accounts/:id/persona", (req, res) => {
  try {
    const snapshot = manager.setAccountPersona(
      req.params.id,
      req.body?.persona
    );
    res.json({ ok: true, account: snapshot });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/accounts/:id/card-drops/scan", (req, res) => {
  try {
    const snapshot = manager.scanAccountCardDrops(req.params.id);
    res.json({ ok: true, account: snapshot });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/accounts/:id/card-farm", (req, res) => {
  try {
    const snapshot = manager.setAccountCardFarm(
      req.params.id,
      req.body?.enabled
    );
    res.json({ ok: true, account: snapshot });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/accounts/:id/clear-session", (req, res) => {
  try {
    const snapshot = manager.clearAccountSession(req.params.id);
    res.json({ ok: true, account: snapshot });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/accounts/:id/guard", (req, res) => {
  try {
    const code = req.body?.code;
    const snapshot = manager.submitGuardCode(req.params.id, code);
    res.json({ ok: true, account: snapshot });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }
  res.redirect("/login");
});

const server = app.listen(PORT, HOST, () => {
  const creds = getCredentials();
  log(null, "Sunucu acildi", `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/login`);
  if (HOST === "0.0.0.0") {
    log(null, "Uzaktan erisim", `http://<sunucu-ip>:${PORT}/login`);
  }
  log(null, "Panel girisi", `kullanici=${creds.username}`);
  if (process.env.STEAM_DEBUG === "1") {
    log(null, "Steam DEBUG modu acik");
  }
});

function shutdown() {
  console.log("\nShutting down...");
  manager.stopAll();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
