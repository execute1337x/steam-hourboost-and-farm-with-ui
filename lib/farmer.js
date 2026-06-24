const EventEmitter = require("events");
const Steam = require("steam-user");
const TOTP = require("steam-totp");
const path = require("path");
const fs = require("fs");

const { normalizePersona } = require("./persona");
const { CardFarmerEngine } = require("./cardFarmer");
const { log, logError, eresultName } = require("./logger");

const MIN_REQUEST_TIME = 60 * 1000;
const LOGON_RETRY_MS = 5 * 1000;
const LOG_ON_INTERVAL = 10 * 60 * 1000;
const REFRESH_GAMES_INTERVAL = 5 * 60 * 1000;

class AccountFarmer extends EventEmitter {
  constructor(account, hooks = {}) {
    super();
    this.account = account;
    this.onPersist = hooks.onPersist || (() => {});
    this.status = "stopped";
    this.message = "Durduruldu";
    this.steamId = null;
    this.authenticated = false;
    this.playingOnOtherSession = false;
    this.currentNotification = null;
    this.lastGameRefreshTime = new Date(0);
    this.lastLogOnTime = new Date(0);
    this.onlyLogInAfter = account.rateLimitUntil
      ? Math.max(0, new Date(account.rateLimitUntil).getTime())
      : 0;
    this._authRetries = 0;
    this.guardResolver = null;
    this.guardDomain = null;
    this.intervals = [];
    this.user = null;
    this._stopRequested = false;
    this._sessionClearedOnce = false;
    this._rateLimitRetryTimer = null;
    this._loginBlocked = false;
    this.farmMode = "hours";
    this.cardFarmer = null;
    this._dropScanner = null;
    this.cardDrops = account.lastCardDrops || [];
    this.cardDropsScanning = false;
    this.cardDropsUpdatedAt = account.lastCardDropsUpdatedAt || null;
    this.startedAt = null;
    this.stoppedAt = account.lastStoppedAt || null;
  }

  get id() {
    return this.account.id;
  }

  get cardFarmActive() {
    return this.farmMode === "cards" && Boolean(this.cardFarmer?.active);
  }

  getSnapshot() {
    return {
      id: this.account.id,
      username: this.account.username,
      status: this.status,
      message: this.message,
      steamId: this.steamId,
      awaitingGuard: this.status === "awaiting_guard",
      guardDomain: this.guardDomain,
      games: this.account.games,
      persona: normalizePersona(this.account.persona),
      cardFarmEnabled: Boolean(this.account.cardFarmEnabled),
      cardFarmActive: this.cardFarmActive,
      farmMode: this.farmMode,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      lastStartedAt: this.account.lastStartedAt || null,
      lastStoppedAt: this.account.lastStoppedAt || null,
      cardDrops: this.cardDrops,
      cardDropsScanning: this.cardDropsScanning,
      cardDropsUpdatedAt: this.cardDropsUpdatedAt,
      rateLimitUntil:
        this.onlyLogInAfter > Date.now()
          ? new Date(this.onlyLogInAfter).toISOString()
          : null,
    };
  }

  _setStatus(status, message) {
    this.status = status;
    this.message = message;
    this.emit("status", this.getSnapshot());
  }

  _setFatalAuthError(message) {
    this._loginBlocked = true;
    this._setStatus("error", message);
  }

  _invalidPasswordMessage() {
    if (this.account.sharedSecret) {
      return "Steam şifresi reddedildi — Accounts'taki şifreyi kontrol edin, sonra Durdur → Başlat";
    }
    return "Steam giriş reddedildi — şifreyi kontrol edin. Mobil Steam Guard varsa Accounts'a shared_secret ekleyin (şifre doğru olsa bile gerekir)";
  }

  _getGames() {
    return (this.account.games || []).map((game) => {
      const asNumber = parseInt(game, 10);
      if (asNumber !== asNumber) return game;
      return asNumber;
    });
  }

  _getDataDir() {
    const dir = path.join(
      process.cwd(),
      "data",
      "steam",
      this.account.id.replace(/[^a-zA-Z0-9_-]/g, "_")
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _clearSteamSession() {
    const dir = this._getDataDir();
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }

  _steamErrorMessage(e) {
    const R = Steam.EResult;
    switch (e.eresult) {
      case R.InvalidPassword:
        return this._invalidPasswordMessage();
      case R.InvalidLoginAuthCode:
      case R.TwoFactorCodeMismatch:
        return "Steam Guard kodu hatalı — tekrar deneyin";
      case R.AccountLogonDenied:
      case R.AccountLogonDeniedVerifiedEmailRequired:
        return "E-posta Steam Guard kodu gerekli — Dashboard'dan kodu girin";
      case R.AccountLoginDeniedNeedTwoFactor:
        return "Mobil Steam Guard gerekli — shared_secret alanına maFile secret ekleyin";
      case R.AccessDenied:
      case R.Expired:
      case R.Revoked:
        return "Steam oturumu geçersiz — oturum temizlenip yeniden denenecek";
      default:
        return `Steam hatası: ${e.message}`;
    }
  }

  _handleSteamAuthError(e) {
    const R = Steam.EResult;
    const name = eresultName(Steam, e.eresult);
    logError(this.account.username, name, e.message);

    const tokenRetry = new Set([
      R.AccessDenied,
      R.Expired,
      R.Revoked,
      R.InvalidSignature,
    ]);

    if (tokenRetry.has(e.eresult) && !this._sessionClearedOnce) {
      this._sessionClearedOnce = true;
      this._clearSteamSession();
      this.authenticated = false;
      log(this.account.username, "Eski token temizlendi, tekrar denenecek");
      this._setStatus("connecting", "Eski oturum temizlendi — tekrar giriş...");
      this._scheduleLogOn(true);
      return;
    }

    if (e.eresult === R.InvalidPassword && !this._sessionClearedOnce) {
      this._sessionClearedOnce = true;
      this._clearSteamSession();
      this.authenticated = false;
      log(this.account.username, "InvalidPassword — oturum silindi, 1 kez daha denenecek");
      this._setStatus("connecting", "Şifre reddedildi — oturum temizlenip tekrar deneniyor...");
      this._scheduleLogOn(true);
      return;
    }

    if (e.eresult === R.InvalidPassword) {
      this._setFatalAuthError(this._invalidPasswordMessage());
      return;
    }

    if (
      e.eresult === R.TwoFactorCodeMismatch ||
      e.eresult === R.InvalidLoginAuthCode
    ) {
      if (this.account.sharedSecret) {
        this._setFatalAuthError(
          "shared_secret hatalı — maFile'daki shared_secret değerini kontrol edin"
        );
        return;
      }
      log(this.account.username, "Guard kodu hatali", "yeni kod girin");
      this._setStatus("awaiting_guard", "Steam Guard kodu hatalı — yeni kod girin");
      return;
    }

    if (
      e.eresult === R.AccountLogonDenied ||
      e.eresult === R.AccountLogonDeniedVerifiedEmailRequired
    ) {
      log(this.account.username, "E-posta Steam Guard gerekli — Dashboard'dan kod girin");
      this._setStatus("awaiting_guard", "E-posta Steam Guard kodu gerekli");
      return;
    }

    if (e.eresult === R.AccountLoginDeniedNeedTwoFactor) {
      if (this.account.sharedSecret) {
        this._authRetries += 1;
        if (this._authRetries > 2) {
          this._setFatalAuthError(
            "Mobil Guard ile giriş başarısız — şifre veya shared_secret hatalı"
          );
          return;
        }
        log(this.account.username, "Mobil Guard — TOTP ile giriş deneniyor");
        this._setStatus("connecting", "Mobil doğrulama kodu gönderiliyor...");
        this._scheduleLogOn(true);
        return;
      }
      logError(
        this.account.username,
        "Mobil Steam Guard var",
        "Accounts'ta shared_secret gerekli"
      );
      this._setFatalAuthError(
        "Mobil Steam Guard aktif — Accounts'ta shared_secret gerekli"
      );
      return;
    }

    this._setFatalAuthError(this._steamErrorMessage(e));
  }

  _rateLimitMessage() {
    const mins = Math.max(1, Math.ceil((this.onlyLogInAfter - Date.now()) / 60000));
    return `Steam rate limit — ~${mins} dk bekleyin`;
  }

  _scheduleRateLimitRetry() {
    if (this._rateLimitRetryTimer) clearTimeout(this._rateLimitRetryTimer);
    const ms = this.onlyLogInAfter - Date.now();
    if (ms <= 0) {
      if (this.user && !this._stopRequested && !this.authenticated) {
        log(this.account.username, "Rate limit suresi doldu", "yeniden deneniyor");
        this._setStatus("connecting", "Rate limit bitti — tekrar deneniyor...");
        this._scheduleLogOn(true);
      }
      return;
    }
    this._rateLimitRetryTimer = setTimeout(() => {
      this._rateLimitRetryTimer = null;
      if (this._stopRequested || !this.user || this.authenticated) return;
      log(this.account.username, "Rate limit suresi doldu", "yeniden deneniyor");
      this._setStatus("connecting", "Rate limit bitti — tekrar deneniyor...");
      this._scheduleLogOn(true);
    }, ms + 1000);
  }

  _scheduleLogOn(force = false) {
    if (this._logOnTimer) clearTimeout(this._logOnTimer);
    this._logOnTimer = setTimeout(() => {
      this._logOnTimer = null;
      this.lastLogOnTime = 0;
      this._logOn(force);
    }, LOGON_RETRY_MS);
  }

  _isCardFarming() {
    return this.farmMode === "cards" && this.cardFarmer?.active;
  }

  start() {
    if (this.user) return;
    this._stopRequested = false;
    this._sessionClearedOnce = false;
    this._loginBlocked = false;
    this._authRetries = 0;
    this.startedAt = new Date().toISOString();
    this.stoppedAt = null;
    this.onPersist({
      lastStartedAt: this.startedAt,
      lastStoppedAt: null,
    });
    this._setStatus("connecting", "Steam'e bağlanılıyor...");

    log(this.account.username, "Baslatildi", `${this._getGames().length} oyun`);

    if (this.onlyLogInAfter > Date.now()) {
      this._setStatus("rate_limited", this._rateLimitMessage());
      this._scheduleRateLimitRetry();
    }

    this.user = new Steam({
      machineIdType: Steam.EMachineIDType.PersistentRandom,
      dataDirectory: this._getDataDir(),
      renewRefreshTokens: true,
    });

    if (process.env.STEAM_DEBUG === "1") {
      this.user.on("debug", (msg) => log(this.account.username, "debug", msg));
    }

    this.user.on("steamGuard", (domain, callback) => {
      if (this.account.sharedSecret) {
        log(this.account.username, "Steam Guard", "TOTP otomatik gonderildi");
        callback(TOTP.generateAuthCode(this.account.sharedSecret));
        return;
      }

      this.guardDomain = domain || null;
      log(
        this.account.username,
        "Steam Guard bekleniyor",
        domain ? `email: ${domain}` : "Dashboard'dan kod girin"
      );
      this._setStatus(
        "awaiting_guard",
        domain
          ? `Steam Guard kodu gerekli (${domain})`
          : "Steam Guard kodu gerekli"
      );

      new Promise((resolve) => {
        this.guardResolver = resolve;
      }).then((code) => {
        this.guardResolver = null;
        this.guardDomain = null;
        callback(code);
      });
    });

    this.user.on("playingState", (blocked) => {
      this.playingOnOtherSession = blocked;
      if (this._isCardFarming()) {
        this.cardFarmer.handlePlayingState(blocked);
        return;
      }
      this._refreshGames();
    });

    this.user.on("webSession", (sessionId, cookies) => {
      if (this.cardFarmer?.active) {
        this.cardFarmer.handleWebSession(sessionId, cookies);
      }
      if (this._dropScanner?.active) {
        this._dropScanner.handleWebSession(sessionId, cookies);
      }
    });

    this.user.on("notificationsReceived", (payload) => {
      if (this._isCardFarming()) {
        this.cardFarmer.handleNotifications(payload);
      }
    });

    this.user.on("loggedOn", () => {
      this.authenticated = true;
      this._authRetries = 0;
      this.onlyLogInAfter = 0;
      this.onPersist({ rateLimitUntil: null });
      this.steamId =
        this.user.steamID?.getSteamID64?.() || String(this.user.steamID);
      log(this.account.username, "Giris basarili", `SteamID ${this.steamId}`);
      this._applyPersona();

      if (this.account.cardFarmEnabled) {
        this._beginCardFarm();
      } else {
        this._setStatus("running", "Saat farmı aktif");
        this._refreshGames();
      }
    });

    this.user.on("error", (e) => {
      switch (e.eresult) {
        case Steam.EResult.LoggedInElsewhere: {
          this.authenticated = false;
          log(this.account.username, "Baska oturum acti", "yeniden baglaniliyor");
          this._setStatus(
            "connecting",
            "Başka oturum bağlandı — yeniden deneniyor..."
          );
          this._scheduleLogOn(true);
          return;
        }
        case Steam.EResult.RateLimitExceeded: {
          this.authenticated = false;
          this.onlyLogInAfter = Date.now() + 31 * 60 * 1000;
          this.onPersist({
            rateLimitUntil: new Date(this.onlyLogInAfter).toISOString(),
          });
          logError(
            this.account.username,
            "RateLimitExceeded",
            "cok fazla giris denemesi — ~30 dk bekleyin, oturum temizlemek yetmez"
          );
          this._setStatus("rate_limited", this._rateLimitMessage());
          this._scheduleRateLimitRetry();
          return;
        }
        default: {
          this._handleSteamAuthError(e);
        }
      }
    });

    this._logOn();
    this.intervals.push(
      setInterval(() => {
        if (
          !this._loginBlocked &&
          this.status !== "awaiting_guard" &&
          this.status !== "rate_limited"
        ) {
          this._logOn();
        }
      }, LOG_ON_INTERVAL)
    );
    this.intervals.push(
      setInterval(() => {
        if (!this._isCardFarming()) {
          this._refreshGames();
        }
      }, REFRESH_GAMES_INTERVAL)
    );
  }

  _syncCardDrops(drops) {
    this.cardDrops = drops.map((d) => ({
      appid: d.appid,
      name: d.name || `App ${d.appid}`,
      drops: d.drops,
      playtime: d.playtime ?? 0,
    }));
    this.cardDropsUpdatedAt = new Date().toISOString();
    this.onPersist({
      lastCardDrops: this.cardDrops,
      lastCardDropsUpdatedAt: this.cardDropsUpdatedAt,
    });
    this.emit("status", this.getSnapshot());
  }

  scanCardDrops() {
    if (!this.authenticated || !this.user) {
      throw new Error("Kart taraması için hesap çalışıyor olmalı");
    }
    if (this.cardDropsScanning) {
      return this.getSnapshot();
    }
    if (this._isCardFarming()) {
      this._syncCardDrops(this.cardFarmer.getDropsList());
      return this.getSnapshot();
    }

    this.cardDropsScanning = true;
    this.emit("status", this.getSnapshot());

    this._dropScanner = new CardFarmerEngine(this.user, {
      onStatus: () => {},
      onLog: (msg) => log(this.account.username, msg),
      onDropsUpdate: (drops) => {
        this.cardDrops = drops.map((d) => ({
          appid: d.appid,
          name: d.name || `App ${d.appid}`,
          drops: d.drops,
          playtime: d.playtime ?? 0,
        }));
        this.emit("status", this.getSnapshot());
      },
      onScanComplete: (drops) => {
        this._dropScanner = null;
        this.cardDropsScanning = false;
        this._syncCardDrops(drops);
      },
      onComplete: () => {},
    });
    this._dropScanner.startScan();
    return this.getSnapshot();
  }

  _beginCardFarm() {
    if (!this.user || !this.authenticated) return;

    this.farmMode = "cards";
    this._stopCardFarm(false);

    this.cardFarmer = new CardFarmerEngine(this.user, {
      onStatus: (msg) => {
        this._setStatus("card_farming", msg);
      },
      onLog: (msg) => log(this.account.username, msg),
      onDropsUpdate: (drops) => {
        this.cardDrops = drops.map((d) => ({
          appid: d.appid,
          name: d.name || `App ${d.appid}`,
          drops: d.drops,
          playtime: d.playtime ?? 0,
        }));
        this.cardDropsUpdatedAt = new Date().toISOString();
        this.emit("status", this.getSnapshot());
      },
      onComplete: () => this._onCardFarmComplete(),
    });

    this.cardFarmer.start();
  }

  _onCardFarmComplete() {
    const drops = this.cardFarmer?.getDropsList() || [];
    this._stopCardFarm(false);
    this.farmMode = "hours";
    this.account.cardFarmEnabled = false;
    this.onPersist({ cardFarmEnabled: false });
    if (drops.length > 0) {
      this._syncCardDrops(drops);
    }
    this._setStatus("running", "Kart farm bitti — saat farmına dönüldü");
    this.lastGameRefreshTime = new Date(0);
    this._refreshGames();
  }

  _stopCardFarm(resetMode = true) {
    if (this._dropScanner) {
      this._dropScanner.stop();
      this._dropScanner = null;
      this.cardDropsScanning = false;
    }
    if (this.cardFarmer) {
      this.cardFarmer.stop();
      this.cardFarmer = null;
    }
    if (resetMode) {
      this.farmMode = "hours";
    }
  }

  setCardFarmEnabled(enabled) {
    const next = Boolean(enabled);
    this.account.cardFarmEnabled = next;
    this.onPersist({ cardFarmEnabled: next });

    if (!next) {
      if (this._isCardFarming()) {
        this._stopCardFarm();
        this.lastGameRefreshTime = new Date(0);
        this._refreshGames();
      }
      return this.getSnapshot();
    }

    if (this.authenticated && !this._isCardFarming()) {
      this._beginCardFarm();
    }

    return this.getSnapshot();
  }

  submitGuardCode(code) {
    if (!this.guardResolver) return false;
    const trimmed = String(code || "").trim();
    if (!trimmed) return false;
    this._loginBlocked = false;
    this._authRetries = 0;
    log(this.account.username, "Guard kodu alindi", "gonderiliyor");
    this._setStatus("connecting", "Steam Guard kodu gönderiliyor...");
    this.guardResolver(trimmed);
    return true;
  }

  _logOn(force = false) {
    if (!this.user || this._stopRequested) return;
    if (this.authenticated) return;
    if (this._loginBlocked && !force) return;
    if (this.status === "awaiting_guard" && !force) return;
    if (!force && Date.now() - this.lastLogOnTime <= MIN_REQUEST_TIME) return;
    if (Date.now() < this.onlyLogInAfter) return;

    const accountName = String(this.account.username || "").trim().toLowerCase();
    const hasSecret = Boolean(this.account.sharedSecret);
    log(
      this.account.username,
      "Steam giris denemesi",
      `user=${accountName}, sifre=${this.account.password ? "var" : "YOK"}, guard=${hasSecret ? "shared_secret" : "manuel"}`
    );

    this.user.logOn({
      accountName,
      password: String(this.account.password || ""),
      machineName: "steam-farmer-panel",
      clientOS: Steam.EOSType.Windows10,
      twoFactorCode: hasSecret
        ? TOTP.generateAuthCode(this.account.sharedSecret)
        : undefined,
      autoRelogin: true,
    });
    this.lastLogOnTime = Date.now();
  }

  _refreshGames() {
    if (!this.user || !this.authenticated || this._isCardFarming()) return;

    if (this.playingOnOtherSession) {
      this._setStatus("paused", "Başka oturumda oyun — saat farm duraklatıldı");
      return;
    }

    if (Date.now() - this.lastGameRefreshTime <= MIN_REQUEST_TIME) return;

    const games = this._getGames();
    if (games.length === 0) {
      this._setStatus("running", "Giriş yapıldı — oyun listesi boş");
      return;
    }

    this.user.gamesPlayed(games);
    this.lastGameRefreshTime = Date.now();
    log(this.account.username, "Saat farmi", `oyunlar: ${games.join(", ")}`);
    this._setStatus("running", "Saat farmı aktif");
  }

  clearSessionAndRestart() {
    this._clearSteamSession();
    this._sessionClearedOnce = false;
    this._loginBlocked = false;

    if (Date.now() < this.onlyLogInAfter) {
      const mins = Math.max(1, Math.ceil((this.onlyLogInAfter - Date.now()) / 60000));
      log(
        this.account.username,
        "Oturum temizlendi",
        `rate limit devam ediyor — ~${mins} dk bekleyin`
      );
      this._setStatus(
        "rate_limited",
        `${this._rateLimitMessage()} (oturum dosyalari silindi)`
      );
      return this.getSnapshot();
    }

    log(this.account.username, "Oturum manuel temizlendi");
    if (this.user && !this.authenticated) {
      this._setStatus("connecting", "Oturum temizlendi — yeniden giriş...");
      this._scheduleLogOn(true);
      return this.getSnapshot();
    }
    return this.getSnapshot();
  }

  stop() {
    if (this._logOnTimer) {
      clearTimeout(this._logOnTimer);
      this._logOnTimer = null;
    }
    if (this._rateLimitRetryTimer) {
      clearTimeout(this._rateLimitRetryTimer);
      this._rateLimitRetryTimer = null;
    }
    log(this.account.username, "Durduruldu");
    this._stopRequested = true;
    this._stopCardFarm();

    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.intervals = [];

    if (this.guardResolver) {
      this.guardResolver = null;
      this.guardDomain = null;
    }

    if (this.user) {
      try {
        this.user.logOff();
      } catch {
        // ignore
      }
      this.user.removeAllListeners();
      this.user = null;
    }

    this.authenticated = false;
    this.steamId = null;
    this.playingOnOtherSession = false;
    this.currentNotification = null;
    this.guardDomain = null;
    this.farmMode = "hours";
    this.stoppedAt = new Date().toISOString();
    this.startedAt = null;
    this.onPersist({ lastStoppedAt: this.stoppedAt });
    this._setStatus("stopped", "Durduruldu");
  }

  _applyPersona() {
    if (!this.user || !this.authenticated) return;
    this.user.setPersona(normalizePersona(this.account.persona));
  }

  setPersona(persona) {
    this.account.persona = normalizePersona(persona);
    this._applyPersona();
    this.emit("status", this.getSnapshot());
    return this.getSnapshot();
  }

  updateAccount(account) {
    const prevPass = this.account.password;
    const prevSecret = this.account.sharedSecret;
    this.account = account;
    if (account.password !== prevPass || account.sharedSecret !== prevSecret) {
      this._loginBlocked = false;
      this._sessionClearedOnce = false;
      this._authRetries = 0;
      if (
        this.user &&
        !this.authenticated &&
        !this._stopRequested &&
        (this.status === "error" || this.status === "connecting")
      ) {
        log(this.account.username, "Hesap bilgileri guncellendi", "yeniden deneniyor");
        this._setStatus("connecting", "Bilgiler güncellendi — yeniden deneniyor...");
        this._scheduleLogOn(true);
      }
    }
  }
}

module.exports = { AccountFarmer };
