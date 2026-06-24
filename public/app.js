const STATUS_LABELS = {
  running: "Çalışıyor",
  stopped: "Durduruldu",
  connecting: "Bağlanıyor",
  paused: "Duraklatıldı",
  awaiting_guard: "Guard bekliyor",
  card_farming: "Kart farm",
  error: "Hata",
  rate_limited: "Rate limit",
};

const PERSONA_OPTIONS = [
  { value: 1, label: "Çevrimiçi" },
  { value: 3, label: "Uzakta" },
  { value: 7, label: "Görünmez" },
  { value: 0, label: "Çevrimdışı" },
];

const FARM_OPTIONS = [
  { value: true, label: "Etkin" },
  { value: false, label: "Etkin değil" },
];

function getPersonaLabel(value) {
  const option = PERSONA_OPTIONS.find((o) => o.value === Number(value));
  return option ? option.label : "Çevrimiçi";
}

function getFarmLabel(enabled, active) {
  if (active) return "Etkin (farm)";
  return enabled ? "Etkin" : "Etkin değil";
}

function formatDateTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRateLimitRemaining(untilIso) {
  if (!untilIso) return null;
  const ms = new Date(untilIso).getTime() - Date.now();
  if (ms <= 0) return "Bekleme bitiyor...";
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `~${mins} dk kaldi`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `~${hours} sa ${rem} dk kaldi` : `~${hours} saat kaldi`;
}

function formatUptime(startedAt) {
  if (!startedAt) return null;
  const ms = Date.now() - new Date(startedAt).getTime();
  const mins = Math.max(1, Math.floor(ms / 60000));
  if (mins < 60) return `${mins} dakikadır çalışıyor`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) {
    return rem > 0
      ? `${hours} saat ${rem} dakikadır çalışıyor`
      : `${hours} saatir çalışıyor`;
  }
  const days = Math.floor(hours / 24);
  return `${days} gündür çalışıyor`;
}

function getStatusBadge(item) {
  const running = item.status !== "stopped";
  if (!running) return STATUS_LABELS.stopped;
  if (item.status === "card_farming") {
    const uptime = formatUptime(item.startedAt);
    return uptime || STATUS_LABELS.card_farming;
  }
  if (item.status === "rate_limited") {
    return formatRateLimitRemaining(item.rateLimitUntil) || STATUS_LABELS.rate_limited;
  }
  if (
    item.status === "running" ||
    item.status === "paused" ||
    item.status === "connecting"
  ) {
    const uptime = formatUptime(item.startedAt);
    if (uptime && item.status === "running") return uptime;
    if (uptime && item.status === "paused") return `${uptime} (duraklatıldı)`;
  }
  return STATUS_LABELS[item.status] || item.status;
}

function renderStatusMeta(item) {
  const lines = [];
  const running = item.status !== "stopped";

  if (running) {
    const uptime = formatUptime(item.startedAt);
    if (uptime) lines.push(uptime);
    const started = formatDateTime(item.startedAt);
    if (started) lines.push(`Başlatıldı: ${started}`);
  } else {
    const stopped = formatDateTime(item.stoppedAt || item.lastStoppedAt);
    if (stopped) lines.push(`Durduruldu: ${stopped}`);
    const lastStart = formatDateTime(item.lastStartedAt);
    if (lastStart) lines.push(`Son başlatma: ${lastStart}`);
  }

  if (item.message && item.message !== "Durduruldu") {
    lines.push(escapeHtml(item.message));
  }
  if (item.status === "error") {
    lines.push(
      '<span class="status-hint">Accounts sekmesinde Steam şifresini ve shared_secret değerini kontrol edin, Kaydet, sonra Yeniden dene.</span>'
    );
  }
  if (item.status === "rate_limited" && item.rateLimitUntil) {
    const retryAt = formatDateTime(item.rateLimitUntil);
    if (retryAt) lines.push(`Tekrar deneme: ${retryAt}`);
  }
  if (item.steamId) lines.push(`Steam ID: ${item.steamId}`);
  if (item.games?.length) {
    lines.push(`Saat farm oyunları: ${escapeHtml(item.games.join(", "))}`);
  }

  return lines.join("<br/>");
}

let openPersonaMenuId = null;
let openFarmMenuId = null;
const openCardDrawers = new Set();
const cardScanTriggered = new Set();

const els = {
  tabs: document.querySelectorAll(".tab"),
  panels: document.querySelectorAll(".panel"),
  dashboardCards: document.getElementById("dashboard-cards"),
  dashboardEmpty: document.getElementById("dashboard-empty"),
  accountRows: document.getElementById("account-rows"),
  addAccountBtn: document.getElementById("add-account"),
  saveAccountsBtn: document.getElementById("save-accounts"),
  refreshStatusBtn: document.getElementById("refresh-status"),
  logoutBtn: document.getElementById("logout-btn"),
  logList: document.getElementById("log-list"),
  logEmpty: document.getElementById("log-empty"),
  refreshLogsBtn: document.getElementById("refresh-logs"),
  clearLogsBtn: document.getElementById("clear-logs"),
  lastUpdate: document.getElementById("last-update"),
  toast: document.getElementById("toast"),
};

let pollTimer = null;
let lastLogId = 0;
let activeTab = "dashboard";
let consoleStream = null;

function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.className = `toast visible${isError ? " error" : ""}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    els.toast.className = "toast";
  }, 3000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Oturum sona erdi");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Istek basarisiz.");
  return data;
}

function switchTab(tabName) {
  activeTab = tabName;
  els.tabs.forEach((tab) =>
    tab.classList.toggle("active", tab.dataset.tab === tabName)
  );
  els.panels.forEach((panel) =>
    panel.classList.toggle("active", panel.id === tabName)
  );
  if (tabName === "logs") {
    lastLogId = 0;
    els.logList.innerHTML = "";
    els.logEmpty.hidden = true;
    loadConsole(true).catch(() => {});
    startConsoleStream();
  } else {
    stopConsoleStream();
  }
}

function formatLogTime(iso) {
  return new Date(iso).toLocaleTimeString("tr-TR", { hour12: false });
}

function appendConsoleLine(entry) {
  els.logEmpty.hidden = true;
  const row = document.createElement("div");
  row.className = `console-line console-${entry.stream || "out"}`;
  row.innerHTML = `<span class="console-time">${formatLogTime(entry.time)}</span><span class="console-text">${escapeHtml(entry.text)}</span>`;
  els.logList.appendChild(row);
  els.logList.scrollTop = els.logList.scrollHeight;
}

function appendConsoleLines(entries, replace = false) {
  if (replace) els.logList.innerHTML = "";
  if (!entries.length) {
    if (replace) els.logEmpty.hidden = false;
    return;
  }
  for (const entry of entries) appendConsoleLine(entry);
}

async function loadConsole(full = false) {
  const since = full ? 0 : lastLogId;
  const data = await api(`/api/console?since=${since}`);
  if (full) {
    appendConsoleLines(data.lines || [], true);
  } else if (data.lines?.length) {
    appendConsoleLines(data.lines, false);
  }
  if (data.latestId) lastLogId = data.latestId;
}

function startConsoleStream() {
  stopConsoleStream();
  consoleStream = new EventSource(`/api/console/stream?since=${lastLogId}`);
  consoleStream.onmessage = (event) => {
    try {
      const entry = JSON.parse(event.data);
      if (entry.id <= lastLogId) return;
      appendConsoleLine(entry);
      lastLogId = entry.id;
    } catch {
      // ignore
    }
  };
  consoleStream.addEventListener("clear", () => {
    els.logList.innerHTML = "";
    lastLogId = 0;
    els.logEmpty.hidden = false;
  });
  consoleStream.onerror = () => {
    stopConsoleStream();
    setTimeout(() => {
      if (activeTab === "logs") startConsoleStream();
    }, 3000);
  };
}

function stopConsoleStream() {
  if (consoleStream) {
    consoleStream.close();
    consoleStream = null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createAccountRow(account = {}) {
  const row = document.createElement("div");
  row.className = "account-row";
  row.dataset.id = account.id || crypto.randomUUID();

  row.innerHTML = `
    <div class="account-row-header">
      <strong>${escapeHtml(account.username || "Yeni Hesap")}</strong>
      <button type="button" class="btn btn-danger btn-sm remove-row">Sil</button>
    </div>
    <div class="form-grid">
      <label>
        Kullanici adi
        <input type="text" name="username" value="${escapeHtml(account.username || "")}" />
      </label>
      <label>
        Sifre
        <input type="password" name="password" value="${escapeHtml(account.password || "")}" placeholder="Steam sifresi" />
      </label>
      <label class="span-2">
        Oyunlar (App ID, virgulle)
        <input type="text" name="games" value="${escapeHtml(
          Array.isArray(account.games) ? account.games.join(", ") : account.games || ""
        )}" placeholder="730, 440" />
      </label>
      <label>
        shared_secret (mobil Steam Guard — önerilir)
        <input type="text" name="sharedSecret" value="${escapeHtml(account.sharedSecret || "")}" placeholder="Mobil doğrulayıcı secret" />
      </label>
    </div>
  `;

  row.querySelector(".remove-row").addEventListener("click", () => {
    row.remove();
    if (!els.accountRows.children.length) createAccountRow();
  });

  row.querySelector('[name="username"]').addEventListener("input", (e) => {
    row.querySelector(".account-row-header strong").textContent =
      e.target.value || "Yeni Hesap";
  });

  els.accountRows.appendChild(row);
}

function readAccountsFromForm() {
  return [...els.accountRows.querySelectorAll(".account-row")].map((row) => ({
    id: row.dataset.id,
    username: row.querySelector('[name="username"]').value.trim(),
    password: row.querySelector('[name="password"]').value,
    games: row.querySelector('[name="games"]').value.trim(),
    sharedSecret: row.querySelector('[name="sharedSecret"]').value.trim(),
  }));
}

function renderAccounts(accounts) {
  els.accountRows.innerHTML = "";
  if (!accounts.length) {
    createAccountRow();
    return;
  }
  accounts.forEach(createAccountRow);
}

function renderPersonaMenu(item) {
  const current = Number(item.persona ?? 1);
  const isOpen = openPersonaMenuId === item.id;
  const options = PERSONA_OPTIONS.map(
    (opt) => `
      <button type="button" class="persona-option${opt.value === current ? " active" : ""}"
        data-id="${item.id}" data-persona="${opt.value}">
        ${opt.label}
      </button>`
  ).join("");

  return `
    <div class="persona-picker${isOpen ? " open" : ""}" data-id="${item.id}">
      <button type="button" class="persona-trigger" data-id="${item.id}">
        ${getPersonaLabel(current)} <span class="persona-caret">▾</span>
      </button>
      <div class="persona-menu">${options}</div>
    </div>`;
}

function renderFarmMenu(item) {
  const enabled = Boolean(item.cardFarmEnabled);
  const isOpen = openFarmMenuId === item.id;
  const options = FARM_OPTIONS.map(
    (opt) => `
      <button type="button" class="farm-option${opt.value === enabled ? " active" : ""}"
        data-id="${item.id}" data-enabled="${opt.value}">
        ${opt.label}
      </button>`
  ).join("");

  return `
    <div class="farm-picker${isOpen ? " open" : ""}" data-id="${item.id}">
      <button type="button" class="farm-trigger" data-id="${item.id}">
        ${getFarmLabel(enabled, item.cardFarmActive)} <span class="persona-caret">▾</span>
      </button>
      <div class="farm-menu">${options}</div>
    </div>`;
}

function renderControlRow(item) {
  return `
    <div class="control-row">
      <div class="control-item">
        <span class="control-label">Durum:</span>
        ${renderPersonaMenu(item)}
      </div>
      <div class="control-item">
        <span class="control-label">Farm:</span>
        ${renderFarmMenu(item)}
      </div>
    </div>`;
}

function getCardDropSummary(item) {
  const drops = item.cardDrops || [];
  const totalCards = drops.reduce((sum, g) => sum + (g.drops || 0), 0);
  return { games: drops.length, cards: totalCards };
}

function renderCardDrawer(item) {
  const isOpen = openCardDrawers.has(item.id);
  const summary = getCardDropSummary(item);
  const running = item.status !== "stopped";
  const updated = item.cardDropsUpdatedAt
    ? formatDateTime(item.cardDropsUpdatedAt)
    : null;

  let body = "";
  if (item.cardDropsScanning) {
    body = `<p class="card-drawer-msg">Kart dropları taranıyor...</p>`;
  } else if (!item.cardDrops?.length) {
    body = `<p class="card-drawer-msg">${
      running
        ? "Henüz veri yok. Taramak için yenile butonuna basın."
        : "Son tarama yok. Kart listesi için hesabı başlatın."
    }</p>`;
  } else {
    const rows = item.cardDrops
      .sort((a, b) => b.drops - a.drops)
      .map(
        (g) => `
        <div class="card-drop-row">
          <span class="card-drop-name">${escapeHtml(g.name || `App ${g.appid}`)}</span>
          <span class="card-drop-meta">App ${g.appid}</span>
          <span class="card-drop-count">${g.drops} kart</span>
        </div>`
      )
      .join("");
    body = `<div class="card-drop-list">${rows}</div>`;
  }

  const label =
    summary.games > 0
      ? `Kart dropları (${summary.games} oyun, ${summary.cards} kart)`
      : "Kart dropları";

  return `
    <div class="card-drawer">
      <button type="button" class="card-drawer-toggle${isOpen ? " open" : ""}" data-id="${item.id}">
        <span>${label}</span>
        <span class="drawer-caret">${isOpen ? "▴" : "▾"}</span>
      </button>
      <div class="card-drawer-panel${isOpen ? " open" : ""}">
        ${body}
        <div class="card-drawer-footer">
          ${updated ? `<span class="card-drawer-updated">Son tarama: ${updated}</span>` : ""}
          ${
            running
              ? `<button type="button" class="btn btn-secondary btn-sm card-scan-btn" data-id="${item.id}"${
                  item.cardDropsScanning ? " disabled" : ""
                }>${item.cardDropsScanning ? "Taranıyor..." : "Yenile"}</button>`
              : ""
          }
        </div>
      </div>
    </div>`;
}

async function triggerCardScan(id, force = false) {
  if (!force && cardScanTriggered.has(id)) return;
  cardScanTriggered.add(id);
  try {
    await api(`/api/accounts/${id}/card-drops/scan`, { method: "POST" });
    await refreshStatus();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    cardScanTriggered.delete(id);
  }
}

function renderDashboard(payload) {
  const statuses = payload.accounts || [];
  els.lastUpdate.textContent = payload.updatedAt
    ? `Son guncelleme: ${new Date(payload.updatedAt).toLocaleTimeString("tr-TR")}`
    : "Guncellendi";

  if (!statuses.length) {
    els.dashboardCards.innerHTML = "";
    els.dashboardEmpty.hidden = false;
    return;
  }

  els.dashboardEmpty.hidden = true;
  els.dashboardCards.innerHTML = statuses
    .map((item) => {
      const running = item.status !== "stopped";
      const badgeText = getStatusBadge(item);
      return `
      <article class="status-card" data-id="${item.id}">
        <div class="status-card-header">
          <h3>${escapeHtml(item.username || item.id)}</h3>
          <span class="state state-${item.status}">${escapeHtml(badgeText)}</span>
        </div>
        <div class="status-meta">
          ${renderStatusMeta(item)}
        </div>
        ${renderControlRow(item)}
        ${renderCardDrawer(item)}
        <div class="status-actions">
          <button class="btn ${running ? "btn-danger" : "btn-success"} btn-sm toggle-btn"
            data-id="${item.id}" data-running="${running}">
            ${running ? "Durdur" : "Baslat"}
          </button>
          ${
            running
              ? `<button class="btn btn-secondary btn-sm clear-session-btn" data-id="${item.id}">Oturumu temizle</button>`
              : ""
          }
          ${
            item.status === "error"
              ? `<button class="btn btn-primary btn-sm retry-login-btn" data-id="${item.id}">Yeniden dene</button>`
              : ""
          }
        </div>
        ${
          item.awaitingGuard
            ? `<div class="guard-box">
                <input type="text" placeholder="Steam Guard kodu" data-guard-input="${item.id}" maxlength="10" />
                <button class="btn btn-primary btn-sm guard-submit" data-id="${item.id}">Gonder</button>
              </div>`
            : ""
        }
      </article>`;
    })
    .join("");

  els.dashboardCards.querySelectorAll(".persona-picker, .farm-picker").forEach((picker) => {
    picker.addEventListener("click", (e) => e.stopPropagation());
  });

  els.dashboardCards.querySelectorAll(".persona-trigger").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      openFarmMenuId = null;
      openPersonaMenuId = openPersonaMenuId === id ? null : id;
      renderDashboard(payload);
    });
  });

  els.dashboardCards.querySelectorAll(".farm-trigger").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      openPersonaMenuId = null;
      openFarmMenuId = openFarmMenuId === id ? null : id;
      renderDashboard(payload);
    });
  });

  els.dashboardCards.querySelectorAll(".persona-option").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const persona = Number(btn.dataset.persona);
      openPersonaMenuId = null;
      try {
        await api(`/api/accounts/${id}/persona`, {
          method: "POST",
          body: JSON.stringify({ persona }),
        });
        showToast(`Durum: ${getPersonaLabel(persona)}`);
        await refreshStatus();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  els.dashboardCards.querySelectorAll(".farm-option").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const enabled = btn.dataset.enabled === "true";
      openFarmMenuId = null;
      try {
        await api(`/api/accounts/${id}/card-farm`, {
          method: "POST",
          body: JSON.stringify({ enabled }),
        });
        showToast(
          enabled
            ? "Kart farm etkin — bitince saat farmına döner"
            : "Kart farm devre dışı"
        );
        await refreshStatus();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  els.dashboardCards.querySelectorAll(".card-drawer-toggle").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const wasOpen = openCardDrawers.has(id);
      if (wasOpen) {
        openCardDrawers.delete(id);
        renderDashboard(payload);
        return;
      }

      openCardDrawers.add(id);
      const item = statuses.find((s) => s.id === id);
      const needsScan =
        item &&
        item.status !== "stopped" &&
        !item.cardDrops?.length &&
        !item.cardDropsScanning;

      renderDashboard(payload);

      if (needsScan) {
        await triggerCardScan(id);
      }
    });
  });

  els.dashboardCards.querySelectorAll(".card-scan-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await triggerCardScan(btn.dataset.id, true);
    });
  });

  els.dashboardCards.querySelectorAll(".clear-session-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const result = await api(`/api/accounts/${btn.dataset.id}/clear-session`, {
          method: "POST",
        });
        if (result.account?.status === "rate_limited") {
          showToast("Oturum silindi — Steam rate limit devam ediyor, bekleyin.");
        } else {
          showToast("Steam oturumu temizlendi, yeniden deneniyor...");
        }
        await refreshStatus();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  els.dashboardCards.querySelectorAll(".retry-login-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api(`/api/accounts/${btn.dataset.id}/clear-session`, { method: "POST" });
        showToast("Yeniden deneniyor...");
        await refreshStatus();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  els.dashboardCards.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const running = btn.dataset.running === "true";
      try {
        if (running) await api(`/api/accounts/${id}/stop`, { method: "POST" });
        else await api(`/api/accounts/${id}/start`, { method: "POST" });
        await refreshStatus();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  els.dashboardCards.querySelectorAll(".guard-submit").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const input = els.dashboardCards.querySelector(`[data-guard-input="${id}"]`);
      try {
        await api(`/api/accounts/${id}/guard`, {
          method: "POST",
          body: JSON.stringify({ code: input.value.trim() }),
        });
        input.value = "";
        showToast("Guard kodu gonderildi.");
        await refreshStatus();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

async function loadAccounts() {
  const data = await api("/api/accounts");
  renderAccounts(data.accounts || []);
}

async function saveAccounts() {
  const accounts = readAccountsFromForm();
  await api("/api/accounts", {
    method: "POST",
    body: JSON.stringify({ accounts }),
  });
  showToast("Hesaplar kaydedildi — çalışan hesaplar otomatik yeniden denenecek.");
  await loadAccounts();
  await refreshStatus();
}

async function refreshStatus() {
  const data = await api("/api/status");
  renderDashboard(data);
}

function startPolling() {
  pollTimer = setInterval(() => {
    refreshStatus().catch(() => {});
  }, 3000);
}

els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

els.addAccountBtn.addEventListener("click", () => createAccountRow());
els.saveAccountsBtn.addEventListener("click", () =>
  saveAccounts().catch((e) => showToast(e.message, true))
);
els.refreshStatusBtn.addEventListener("click", () =>
  refreshStatus().catch((e) => showToast(e.message, true))
);

els.refreshLogsBtn.addEventListener("click", () =>
  loadConsole(true).catch((e) => showToast(e.message, true))
);

els.clearLogsBtn.addEventListener("click", () =>
  api("/api/console/clear", { method: "POST" })
    .then(() => {
      lastLogId = 0;
      els.logList.innerHTML = "";
      els.logEmpty.hidden = false;
      showToast("Konsol temizlendi.");
    })
    .catch((e) => showToast(e.message, true))
);

els.logoutBtn.addEventListener("click", () => {
  api("/api/auth/logout", { method: "POST" })
    .then(() => {
      window.location.href = "/login";
    })
    .catch(() => {
      window.location.href = "/login";
    });
});

document.addEventListener("click", () => {
  if (openPersonaMenuId || openFarmMenuId) {
    openPersonaMenuId = null;
    openFarmMenuId = null;
    refreshStatus().catch(() => {});
  }
});

(async function init() {
  try {
    await loadAccounts();
    await refreshStatus();
    startPolling();
  } catch (err) {
    showToast(err.message, true);
  }
})();

window.addEventListener("beforeunload", () => {
  if (pollTimer) clearInterval(pollTimer);
  stopConsoleStream();
});
