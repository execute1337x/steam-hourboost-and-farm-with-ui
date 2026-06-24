const { JSDOM } = require("jsdom");

const MAX_APPS_AT_ONCE = 32;
const MIN_PLAYTIME_TO_IDLE = 180;
const CYCLE_MINUTES_BETWEEN = 10;
const CYCLE_DELAY = 10000;
const CYCLE_APPS_AT_ONCE = 4;
const ITEM_NOTIFICATION_TYPE = 4;

function arrayTakeFirst(arr, end) {
  return arr.slice(0, Math.min(end, arr.length));
}

function arrayShuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CardFarmerEngine {
  constructor(client, handlers = {}) {
    this.client = client;
    this.onStatus = handlers.onStatus || (() => {});
    this.onComplete = handlers.onComplete || (() => {});
    this.onDropsUpdate = handlers.onDropsUpdate || (() => {});
    this.onScanComplete = handlers.onScanComplete || (() => {});
    this.onLog = handlers.onLog || (() => {});

    this.appsWithDrops = [];
    this.cookies = [];
    this.checkTimer = null;
    this.playStateBlocked = false;
    this.lastBadgesCheck = Date.now();
    this.active = false;
    this.scanOnly = false;
  }

  getDropsList() {
    return this.appsWithDrops.map((a) => ({ ...a }));
  }

  _notifyDrops() {
    if (this.onDropsUpdate) {
      this.onDropsUpdate(this.getDropsList());
    }
  }

  startScan() {
    if (this.active) return;
    this.scanOnly = true;
    this.active = true;
    this.appsWithDrops = [];
    this.onStatus("Kart dropları taranıyor...");
    this.client.webLogOn();
  }

  start() {
    if (this.active) return;
    this.scanOnly = false;
    this.active = true;
    this.appsWithDrops = [];
    this.onStatus("Kart dropları taranıyor...");
    this.client.webLogOn();
  }

  stop() {
    this.active = false;
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
    this.appsWithDrops = [];
    this.cookies = [];
  }

  handleWebSession(_sessionId, cookies) {
    if (!this.active) return;

    this.cookies = [...cookies, "Steam_Language=english"];

    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.appsWithDrops = [];
      this.requestBadgesPage(1);
    }, 2000);
  }

  handlePlayingState(blocked) {
    if (!this.active || this.playStateBlocked === blocked) return;

    this.playStateBlocked = blocked;

    if (blocked) {
      this.onStatus("Başka oturumda oyun açık — kart farm duraklatıldı");
      return;
    }

    this.onStatus("Kart farm devam ediyor...");
    if (this.appsWithDrops.length > 0) {
      this.idle();
    }
  }

  handleNotifications(payload) {
    if (!this.active || !payload?.notifications) return;

    const notificationIdsToRead = [];

    for (const notification of payload.notifications) {
      if (notification.type !== ITEM_NOTIFICATION_TYPE) continue;
      if (notification.read || notification.viewed > 0) continue;

      const item = notification.body;
      if (!item || String(item.app_id) !== "753" || String(item.context_id) !== "6") {
        continue;
      }

      const sourceAppId = Number(item.source_appid);
      const appIndex = this.appsWithDrops.findIndex((a) => a.appid === sourceAppId);
      if (appIndex < 0) continue;

      const app = this.appsWithDrops[appIndex];
      app.drops -= 1;
      this.onLog(`Kart düştü: App ${sourceAppId}, kalan: ${app.drops}`);

      if (app.drops < 1) {
        this.appsWithDrops.splice(appIndex, 1);
      }

      this._notifyDrops();
      notificationIdsToRead.push(notification.id);
    }

    if (notificationIdsToRead.length > 0 && this.client.markNotificationsRead) {
      this.client.markNotificationsRead(notificationIdsToRead);
    }
  }

  async requestBadgesPage(page, syncOnly = false) {
    if (!this.active) return;

    let document;
    try {
      let urlPart = "";
      if (this.client.vanityURL) {
        urlPart = `id/${this.client.vanityURL}`;
      } else if (this.client.steamID) {
        urlPart = `profiles/${this.client.steamID.getSteamID64()}`;
      } else {
        throw new Error("Steam ID bulunamadı");
      }

      const response = await fetch(
        `https://steamcommunity.com/${urlPart}/badges/?l=english&p=${page}`,
        {
          headers: {
            "User-Agent": "steam-farmer-panel (+https://github.com/xPaw/Steam-Card-Farmer)",
            Cookie: this.cookies.join("; "),
          },
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        }
      );

      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }

      const text = await response.text();
      if (text.includes("g_steamID = false")) {
        this.onLog("Badges sayfası oturum dışı, web oturumu yenileniyor...");
        this.client.webLogOn();
        return;
      }

      document = new JSDOM(text).window.document;
    } catch (err) {
      this.onLog(`Badges sayfa ${page} hatası: ${err.message}`);
      if (this.checkTimer) clearTimeout(this.checkTimer);
      this.checkTimer = setTimeout(() => this.requestBadgesPage(page, syncOnly), 30000);
      return;
    }

    let pageDrops = 0;
    let pageApps = 0;
    const appIdToIndex = new Map();
    for (let i = 0; i < this.appsWithDrops.length; i += 1) {
      appIdToIndex.set(this.appsWithDrops[i].appid, i);
    }

    for (const infoline of document.querySelectorAll(".progress_info_bold")) {
      const match = infoline.textContent?.match(/(\d+)/);
      if (!match) continue;

      const row = infoline.closest(".badge_row");
      const href = row?.querySelector(".badge_title_playgame a")?.getAttribute("href");
      if (!row || !href) continue;

      const urlParts = href.split("/");
      const appid = parseInt(urlParts[urlParts.length - 1], 10) || 0;
      const drops = parseInt(match[1], 10) || 0;
      if (appid < 1 || drops < 1) continue;

      pageDrops += drops;
      pageApps += 1;

      let playtime = 0;
      const playTimeMatch = row
        .querySelector(".badge_title_stats_playtime")
        ?.textContent?.match(/(?<playtime>\d+\.\d+)/);
      if (playTimeMatch?.groups?.playtime) {
        playtime = Math.round(parseFloat(playTimeMatch.groups.playtime) * 60);
      }

      const name =
        row.querySelector(".badge_title_playgame a")?.textContent?.trim() ||
        row.querySelector(".badge_title")?.textContent?.trim() ||
        `App ${appid}`;

      const existingIndex = appIdToIndex.get(appid);
      if (existingIndex !== undefined) {
        this.appsWithDrops[existingIndex].drops = drops;
        this.appsWithDrops[existingIndex].playtime = playtime;
        this.appsWithDrops[existingIndex].name = name;
        continue;
      }

      appIdToIndex.set(appid, this.appsWithDrops.length);
      this.appsWithDrops.push({ appid, playtime, drops, name });
    }

    if (pageDrops > 0) {
      this.onLog(
        `Sayfa ${page}: ${pageDrops} kart, ${pageApps} oyunda`
      );
    }

    let lastPage = page;
    const pageLinks = document.querySelectorAll(".pagelink");
    if (pageLinks.length > 0) {
      lastPage =
        parseInt(pageLinks[pageLinks.length - 1].textContent || String(page), 10) ||
        page;
    }

    if (page < lastPage) {
      this.requestBadgesPage(page + 1, syncOnly);
      return;
    }

    this.lastBadgesCheck = Date.now();
    this._notifyDrops();

    if (this.scanOnly) {
      this.onStatus(
        this.appsWithDrops.length > 0
          ? `${this.appsWithDrops.length} oyunda kart bulundu`
          : "Kart drop kalmadı"
      );
      const drops = this.getDropsList();
      this.stop();
      this.onScanComplete(drops);
      return;
    }

    if (syncOnly) return;

    if (this.appsWithDrops.length > 0) {
      const total = this.appsWithDrops.reduce((sum, a) => sum + a.drops, 0);
      this.onStatus(`${total} kart drop — ${this.appsWithDrops.length} oyunda farm başlıyor`);
      this.idle();
      return;
    }

    this.onStatus("Kart drop kalmadı — saat farmına dönülüyor");
    this.finish();
  }

  getAppsToPlay() {
    let appsToPlay = [];
    let requiresIdling = false;
    const appsUnderMin = this.appsWithDrops.filter(
      (a) => a.playtime < MIN_PLAYTIME_TO_IDLE
    );

    if (
      appsUnderMin.length > 0 &&
      appsUnderMin.length >= this.appsWithDrops.length / 2
    ) {
      requiresIdling = true;
      appsToPlay = [...appsUnderMin];

      if (appsUnderMin.length < MAX_APPS_AT_ONCE) {
        const appsOver = this.appsWithDrops
          .filter((a) => a.playtime >= MIN_PLAYTIME_TO_IDLE)
          .sort((a, b) => a.playtime - b.playtime);
        appsToPlay.push(
          ...arrayTakeFirst(appsOver, MAX_APPS_AT_ONCE - appsUnderMin.length)
        );
      }
    } else {
      appsToPlay = [...this.appsWithDrops];
    }

    appsToPlay.sort((a, b) => b.playtime - a.playtime);
    appsToPlay = arrayTakeFirst(appsToPlay, MAX_APPS_AT_ONCE);
    const medianPlaytime =
      appsToPlay.length > 0
        ? appsToPlay[Math.floor(appsToPlay.length / 2)].playtime
        : 0;

    arrayShuffle(appsToPlay);
    return { requiresIdling, appsToPlay, medianPlaytime };
  }

  idle() {
    if (!this.active) return;

    if (this.playStateBlocked) {
      this.onStatus("Başka oturumda oyun — kart farm bekliyor");
      return;
    }

    if (!this.client.steamID) {
      this.onStatus("Steam bağlantısı yok");
      return;
    }

    const totalDropsLeft = this.appsWithDrops.reduce(
      (total, { drops }) => total + drops,
      0
    );

    const { requiresIdling, appsToPlay, medianPlaytime } = this.getAppsToPlay();
    const appids = appsToPlay.map(({ appid }) => appid);
    this.client.gamesPlayed(appids);

    let idleMinutes = CYCLE_MINUTES_BETWEEN;
    let idlingForPlaytime = requiresIdling;

    if (requiresIdling) {
      idleMinutes = MIN_PLAYTIME_TO_IDLE - medianPlaytime;
      if (idleMinutes < CYCLE_MINUTES_BETWEEN) {
        idlingForPlaytime = false;
        idleMinutes = CYCLE_MINUTES_BETWEEN;
      }
    }

    if (idlingForPlaytime) {
      this.onStatus(
        `Kart farm: ${appsToPlay.length} oyun, ${idleMinutes} dk (playtime)`
      );
    } else {
      this.onStatus(
        `Kart farm: ${appsToPlay.length} oyun, ${totalDropsLeft} kart kaldı`
      );
    }

    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(async () => {
      if (!this.active) return;

      if (this.playStateBlocked) {
        this.onStatus("Başka oturumda oyun — döngü atlandı");
        return;
      }

      for (const app of appsToPlay) {
        app.playtime += idleMinutes;
      }

      if (idlingForPlaytime) {
        this.client.gamesPlayed([]);
      } else {
        await this.cycleApps(appids);
      }

      if (this.checkTimer) clearTimeout(this.checkTimer);
      this.checkTimer = setTimeout(() => {
        if (!this.active) return;

        if (this.appsWithDrops.length === 0) {
          this.onStatus("Kartlar bitti — rozetler yeniden taranıyor");
          this.requestBadgesPage(1);
          return;
        }

        if (Date.now() - this.lastBadgesCheck >= 1000 * 60 * 180) {
          this.requestBadgesPage(1, true);
        }

        this.idle();
      }, CYCLE_DELAY);
    }, 1000 * 60 * idleMinutes);
  }

  async cycleApps(appids) {
    let current = CYCLE_APPS_AT_ONCE;
    let remaining = appids;

    do {
      await sleep(CYCLE_DELAY);
      if (!this.active || this.playStateBlocked) return;

      remaining = appids.slice(current);
      this.client.gamesPlayed(remaining);
      current += CYCLE_APPS_AT_ONCE;
    } while (remaining.length > 0);
  }

  finish() {
    this.stop();
    this.onComplete();
  }
}

module.exports = { CardFarmerEngine };
