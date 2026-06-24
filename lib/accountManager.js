const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const TOTP = require("steam-totp");
const { AccountFarmer } = require("./farmer");
const { normalizePersona, ALLOWED_PERSONA } = require("./persona");
const { log } = require("./logger");

const DATA_DIR = path.join(process.cwd(), "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");

class AccountManager {
  constructor() {
    this.farmers = new Map();
    this._ensureDataDir();
  }

  _ensureDataDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(ACCOUNTS_FILE)) {
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts: [] }, null, 2));
    }
  }

  _patchAccount(id, patch) {
    const accounts = this.loadAccounts();
    const index = accounts.findIndex((a) => a.id === id);
    if (index === -1) return;

    accounts[index] = { ...accounts[index], ...patch };
    fs.writeFileSync(
      ACCOUNTS_FILE,
      JSON.stringify({ accounts }, null, 2),
      "utf8"
    );

    const farmer = this.farmers.get(id);
    if (farmer) {
      farmer.updateAccount(accounts[index]);
    }
  }

  loadAccounts() {
    const raw = fs.readFileSync(ACCOUNTS_FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.accounts) ? data.accounts : [];
  }

  saveAccounts(accounts) {
    const existing = this.loadAccounts();
    const existingById = new Map(existing.map((a) => [a.id, a]));

    const normalized = accounts.map((acc) => {
      const prev = existingById.get(acc.id);
      const sharedSecret =
        acc.sharedSecret || acc.shared_secret || prev?.sharedSecret || "";
      this._validateSharedSecret(String(sharedSecret).trim());
      return this._normalizeAccount({
        ...acc,
        password: acc.password || prev?.password || "",
        sharedSecret,
        persona: acc.persona ?? prev?.persona,
        cardFarmEnabled: acc.cardFarmEnabled ?? prev?.cardFarmEnabled ?? false,
        lastStartedAt: prev?.lastStartedAt ?? null,
        lastStoppedAt: prev?.lastStoppedAt ?? null,
        lastCardDrops: prev?.lastCardDrops ?? [],
        lastCardDropsUpdatedAt: prev?.lastCardDropsUpdatedAt ?? null,
        rateLimitUntil: prev?.rateLimitUntil ?? null,
      });
    });

    fs.writeFileSync(
      ACCOUNTS_FILE,
      JSON.stringify({ accounts: normalized }, null, 2),
      "utf8"
    );

    for (const farmer of this.farmers.values()) {
      const updated = normalized.find((a) => a.id === farmer.id);
      if (updated) {
        farmer.updateAccount(updated);
      }
    }

    log(null, "Hesaplar kaydedildi", `${normalized.length} hesap`);
    return normalized;
  }

  _normalizeAccount(acc) {
    const games = Array.isArray(acc.games)
      ? acc.games
      : String(acc.games || "")
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean);

    return {
      id: acc.id || uuidv4(),
      username: String(acc.username || "").trim(),
      password: String(acc.password || ""),
      games,
      sharedSecret: String(acc.sharedSecret || acc.shared_secret || "").trim(),
      persona: normalizePersona(acc.persona),
      cardFarmEnabled: Boolean(acc.cardFarmEnabled),
      lastStartedAt: acc.lastStartedAt || null,
      lastStoppedAt: acc.lastStoppedAt || null,
      lastCardDrops: Array.isArray(acc.lastCardDrops) ? acc.lastCardDrops : [],
      lastCardDropsUpdatedAt: acc.lastCardDropsUpdatedAt || null,
      rateLimitUntil: acc.rateLimitUntil || null,
    };
  }

  _validateSharedSecret(secret) {
    if (!secret) return;
    try {
      TOTP.generateAuthCode(secret);
    } catch {
      throw new Error("shared_secret geçersiz — maFile'daki değeri kontrol edin");
    }
  }

  getAccountsForClient() {
    return this.loadAccounts().map((acc) => ({
      id: acc.id,
      username: acc.username,
      password: acc.password,
      games: acc.games,
      sharedSecret: acc.sharedSecret || "",
      persona: acc.persona,
      cardFarmEnabled: Boolean(acc.cardFarmEnabled),
      lastStartedAt: acc.lastStartedAt || null,
      lastStoppedAt: acc.lastStoppedAt || null,
      running:
        this.farmers.has(acc.id) &&
        this.farmers.get(acc.id).status !== "stopped",
    }));
  }

  getAllStatus() {
    const accounts = this.loadAccounts();
    const statuses = accounts.map((acc) => {
      const farmer = this.farmers.get(acc.id);
      if (farmer) {
        return farmer.getSnapshot();
      }
      return {
        id: acc.id,
        username: acc.username,
        status: "stopped",
        message: "Durduruldu",
        steamId: null,
        awaitingGuard: false,
        guardDomain: null,
        games: acc.games,
        persona: normalizePersona(acc.persona),
        cardFarmEnabled: Boolean(acc.cardFarmEnabled),
        cardFarmActive: false,
        farmMode: "hours",
        startedAt: null,
        stoppedAt: acc.lastStoppedAt || null,
        lastStartedAt: acc.lastStartedAt || null,
        lastStoppedAt: acc.lastStoppedAt || null,
        cardDrops: acc.lastCardDrops || [],
        cardDropsScanning: false,
        cardDropsUpdatedAt: acc.lastCardDropsUpdatedAt || null,
        rateLimitUntil: acc.rateLimitUntil || null,
      };
    });
    return { accounts: statuses, updatedAt: new Date().toISOString() };
  }

  startAccount(id) {
    const accounts = this.loadAccounts();
    const account = accounts.find((a) => a.id === id);
    if (!account) throw new Error("Hesap bulunamadı");
    if (!account.username || !account.password) {
      throw new Error("Kullanıcı adı ve Steam şifresi gerekli");
    }
    if (!account.games || account.games.length === 0) {
      throw new Error("En az bir oyun App ID gerekli");
    }
    this._validateSharedSecret(account.sharedSecret);

    let farmer = this.farmers.get(id);
    if (farmer && farmer.user) {
      return farmer.getSnapshot();
    }

    if (farmer) {
      farmer.stop();
      this.farmers.delete(id);
    }

    farmer = new AccountFarmer(account, {
      onPersist: (patch) => this._patchAccount(id, patch),
    });
    this.farmers.set(id, farmer);
    log(account.username, "Panelden baslatildi");
    farmer.start();
    return farmer.getSnapshot();
  }

  stopAccount(id) {
    const farmer = this.farmers.get(id);
    if (!farmer) {
      const acc = this.loadAccounts().find((a) => a.id === id);
      return {
        id,
        status: "stopped",
        message: "Durduruldu",
        lastStoppedAt: acc?.lastStoppedAt || null,
      };
    }
    farmer.stop();
    this.farmers.delete(id);
    log(farmer.account.username, "Panelden durduruldu");
    return farmer.getSnapshot();
  }

  setAccountPersona(id, persona) {
    const parsed = parseInt(persona, 10);
    if (!ALLOWED_PERSONA.has(parsed)) {
      throw new Error("Geçersiz durum seçimi");
    }

    this._patchAccount(id, { persona: parsed });

    const farmer = this.farmers.get(id);
    if (farmer) {
      return farmer.setPersona(parsed);
    }

    const acc = this.loadAccounts().find((a) => a.id === id);
    return {
      id,
      username: acc?.username,
      status: "stopped",
      message: "Durduruldu",
      persona: parsed,
    };
  }

  setAccountCardFarm(id, enabled) {
    const next = Boolean(enabled);
    this._patchAccount(id, { cardFarmEnabled: next });

    const farmer = this.farmers.get(id);
    if (farmer) {
      return farmer.setCardFarmEnabled(next);
    }

    const acc = this.loadAccounts().find((a) => a.id === id);
    return {
      id,
      username: acc?.username,
      status: "stopped",
      message: "Durduruldu",
      cardFarmEnabled: next,
    };
  }

  scanAccountCardDrops(id) {
    const farmer = this.farmers.get(id);
    if (!farmer) {
      throw new Error("Kart taraması için hesabı başlatın");
    }
    return farmer.scanCardDrops();
  }

  clearAccountSession(id) {
    const farmer = this.farmers.get(id);
    if (!farmer) {
      const dir = path.join(
        process.cwd(),
        "data",
        "steam",
        id.replace(/[^a-zA-Z0-9_-]/g, "_")
      );
      if (fs.existsSync(dir)) {
        for (const entry of fs.readdirSync(dir)) {
          fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        }
      }
      return { id, message: "Steam oturumu temizlendi" };
    }
    return farmer.clearSessionAndRestart();
  }

  submitGuardCode(id, code) {
    const farmer = this.farmers.get(id);
    if (!farmer) throw new Error("Account is not running");
    const ok = farmer.submitGuardCode(code);
    if (!ok) throw new Error("Account is not waiting for a Steam Guard code");
    return farmer.getSnapshot();
  }

  stopAll() {
    for (const id of [...this.farmers.keys()]) {
      this.stopAccount(id);
    }
  }
}

module.exports = { AccountManager, ACCOUNTS_FILE };
