const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const AUTH_FILE = path.join(process.cwd(), "data", "auth.json");

const DEFAULT_USER = "admin";
const DEFAULT_PASSWORD = "changeme";

function writeDefaultAuth() {
  const config = {
    username: process.env.AUTH_USERNAME || DEFAULT_USER,
    password: process.env.AUTH_PASSWORD || DEFAULT_PASSWORD,
  };
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(config, null, 2), "utf8");
  return config;
}

function ensureAuthConfig() {
  if (process.env.AUTH_RESET === "1") {
    return writeDefaultAuth();
  }

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

  if (!fs.existsSync(AUTH_FILE)) {
    return writeDefaultAuth();
  }

  try {
    const file = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    if (!file.username || !file.password) {
      return writeDefaultAuth();
    }
    return file;
  } catch {
    return writeDefaultAuth();
  }
}

function getCredentials() {
  const file = ensureAuthConfig();
  return {
    username: String(process.env.AUTH_USERNAME || file.username || DEFAULT_USER).trim(),
    password: String(process.env.AUTH_PASSWORD || file.password || DEFAULT_PASSWORD),
  };
}

function verifyLogin(username, password) {
  const creds = getCredentials();
  const inputUser = String(username || "").trim().toLowerCase();
  const inputPass = String(password || "");
  return (
    inputUser === creds.username.toLowerCase() && inputPass === creds.password
  );
}

function getSessionSecret() {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }
  const secretFile = path.join(process.cwd(), "data", ".session-secret");
  if (fs.existsSync(secretFile)) {
    return fs.readFileSync(secretFile, "utf8").trim();
  }
  const secret = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  fs.writeFileSync(secretFile, secret, "utf8");
  return secret;
}

module.exports = {
  verifyLogin,
  getSessionSecret,
  getCredentials,
  DEFAULT_USER,
  DEFAULT_PASSWORD,
};
