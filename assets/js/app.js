/**
 * 啟動與狀態管理。
 *
 * 兩種資料來源：
 *   快照模式（預設）—— 讀 data/latest.json，由 GitHub Actions 每日產生，只含公開資料。
 *   即時模式       —— 帶使用者自己的 PAT 直接打 GitHub API，補上私人 repo 與帳單。
 *                     權杖與結果都只存在這台裝置的 localStorage，永不上傳。
 */

import { render } from './ui.js';
import { collectSnapshot } from './collect.js';
import { el } from './charts.js';

const STORE = {
  token: 'ghsd.token',
  theme: 'ghsd.theme',
  range: 'ghsd.range',
  live: 'ghsd.live-snapshot',
  liveHistory: 'ghsd.live-history',
};

const state = {
  config: null,
  snapshot: null,
  history: [],
  rangeDays: 30,
  mode: 'snapshot',   // 'snapshot' | 'live'
};

const root = document.getElementById('dashboard');
const progressBar = document.getElementById('progress');

// localStorage 在無痕視窗、關閉站台資料的瀏覽器裡會直接丟例外，一律包起來。
const store = {
  get(k, fallback = null) { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 忽略：只是便利功能 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
  json(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
};

// ---------------------------------------------------------------- 主題

function applyTheme(theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  store.set(STORE.theme, theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    const next = { system: 'light', light: 'dark', dark: 'system' }[theme];
    btn.setAttribute('aria-label', `切換主題（目前：${{ system: '跟隨系統', light: '淺色', dark: '深色' }[theme]}）`);
    btn.title = btn.getAttribute('aria-label');
    btn.dataset.theme = theme;
    btn.dataset.next = next;
  }
}

// ---------------------------------------------------------------- 載入

async function loadJson(url, fallback = null) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return fallback;
    return await res.json();
  } catch { return fallback; }
}

async function boot() {
  applyTheme(store.get(STORE.theme, 'system'));
  state.rangeDays = parseRange(store.get(STORE.range, '30'));

  const demo = new URLSearchParams(location.search).has('demo');
  state.config = await loadJson('./config.json', DEFAULT_CONFIG);

  if (demo) {
    state.snapshot = await loadJson('./data/demo.json');
    state.history = await loadJson('./data/demo-history.json', []);
    if (state.snapshot) state.snapshot.demo = true;
  } else {
    // 上次即時掃描的結果優先，這樣重新整理不會退回只剩公開資料的畫面。
    const cachedLive = store.json(STORE.live, null);
    state.snapshot = cachedLive ?? await loadJson('./data/latest.json');
    state.history = cachedLive
      ? store.json(STORE.liveHistory, [])
      : await loadJson('./data/history.json', []);
    state.mode = cachedLive ? 'live' : 'snapshot';
  }

  if (!state.snapshot) {
    root.replaceChildren(el('div', { class: 'banner critical' }, [
      el('div', { class: 'body' }, [
        el('strong', { text: '還沒有任何快照資料' }),
        el('p', { text: '請先在 GitHub 上手動觸發一次「每日儲存空間快照」workflow，或直接點右上角「即時掃描」貼上你的存取權杖。' }),
      ]),
    ]));
    wireChrome();
    return;
  }

  // 歷史至少要有一筆，否則趨勢卡連目前這個點都畫不出來。
  if (!state.history.length && state.snapshot) {
    state.history = [summarise(state.snapshot)];
  }

  wireChrome();
  paint();
}

function paint() {
  const hasToken = Boolean(store.get(STORE.token));
  render(root, {
    snapshot: state.snapshot,
    history: state.history,
    config: state.config,
    rangeDays: state.rangeDays,
    rangeLabel: rangeLabel(state.rangeDays),
    hasToken,
  });
  updateChrome();
}

// ---------------------------------------------------------------- 頂列互動

function wireChrome() {
  document.getElementById('theme-toggle')?.addEventListener('click', (e) => {
    applyTheme(e.currentTarget.dataset.next ?? 'light');
  });

  document.querySelectorAll('#range-filter button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.rangeDays = parseRange(btn.dataset.range);
      store.set(STORE.range, btn.dataset.range);
      document.querySelectorAll('#range-filter button')
        .forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      paint();
    });
  });

  document.getElementById('live-scan')?.addEventListener('click', openTokenDialog);
  document.getElementById('reset-live')?.addEventListener('click', async () => {
    store.del(STORE.live); store.del(STORE.liveHistory); store.del(STORE.token);
    state.mode = 'snapshot';
    state.snapshot = await loadJson('./data/latest.json');
    state.history = await loadJson('./data/history.json', []);
    paint();
  });

  const saved = store.get(STORE.range, '30');
  document.querySelectorAll('#range-filter button')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === saved)));
}

function updateChrome() {
  const snap = state.snapshot;
  const stamp = document.getElementById('stamp');
  if (stamp && snap) {
    const d = new Date(snap.generatedAt);
    stamp.textContent = `更新於 ${d.toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' })}`;
  }
  const chip = document.getElementById('account-chip');
  if (chip && snap?.account) {
    chip.href = snap.account.htmlUrl;
    chip.replaceChildren(
      snap.account.avatarUrl ? el('img', { src: snap.account.avatarUrl, alt: '' }) : null,
      el('span', { text: snap.account.login }),
    );
  }
  const modeBadge = document.getElementById('mode-badge');
  if (modeBadge) {
    modeBadge.textContent = state.mode === 'live' ? '即時（含私人）' : '每日快照（僅公開）';
    modeBadge.className = `badge ${state.mode === 'live' ? 'good' : 'neutral'}`;
  }
  document.getElementById('reset-live').hidden = state.mode !== 'live';
}

// ---------------------------------------------------------------- 即時掃描

function openTokenDialog() {
  const dialog = document.getElementById('token-dialog');
  const input = dialog.querySelector('input');
  input.value = store.get(STORE.token, '');
  dialog.showModal();
}

async function runLiveScan(token, includePrivate) {
  document.body.classList.add('refreshing');
  progressBar.style.opacity = '1';

  try {
    const snap = await collectSnapshot({
      login: state.config.account,
      token,
      includePrivate,
      // 即時模式的結果只存在這台裝置，所以帳單資料在這裡才抓。
      includeBilling: true,
      source: 'browser',
      onProgress: (msg, pct) => {
        progressBar.style.width = `${pct}%`;
        document.getElementById('stamp').textContent = msg;
      },
    });

    state.snapshot = snap;
    state.mode = 'live';
    store.set(STORE.live, JSON.stringify(snap));

    // 即時模式維護自己的歷史，才不會把含私人 repo 的數字混進公開快照序列。
    const history = store.json(STORE.liveHistory, []);
    const today = snap.generatedAt.slice(0, 10);
    const merged = [...history.filter((h) => h.date !== today), summarise(snap)]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-state.config.history.retainDays);
    store.set(STORE.liveHistory, JSON.stringify(merged));
    state.history = merged;

    paint();
  } catch (err) {
    alert(`掃描失敗：${err.message}`);
  } finally {
    document.body.classList.remove('refreshing');
    progressBar.style.opacity = '0';
    progressBar.style.width = '0';
  }
}

function summarise(snap) {
  const t = snap.totals;
  return {
    date: snap.generatedAt.slice(0, 10),
    repoBytes: t.repoBytes, artifactBytes: t.artifactBytes,
    expiredArtifactBytes: t.expiredArtifactBytes, cacheBytes: t.cacheBytes,
    releaseBytes: t.releaseBytes, lfsBytes: t.lfsBytes,
    allBytes: t.allBytes, repoCount: snap.counts.repos,
  };
}

// ---------------------------------------------------------------- 工具

function parseRange(v) { return v === 'all' ? 'all' : Number(v) || 30; }
function rangeLabel(v) { return v === 'all' ? '（全期間）' : `（近 ${v} 天）`; }

const DEFAULT_CONFIG = {
  account: '', plan: 'free',
  quotas: { free: { sharedStorageGB: 0.5, actionsMinutes: 2000, lfsStorageGB: 1, lfsBandwidthGB: 1, packagesBandwidthGB: 1 } },
  advisory: { repoSoftLimitGB: 5, repoPushWarnGB: 2, fileHardLimitMB: 100, fileWarnMB: 50, cachePerRepoGB: 10, releaseAssetMaxGB: 2 },
  alerts: { warnPercent: 75, criticalPercent: 90, forecastHorizonDays: 90, staleRepoDays: 180 },
  history: { retainDays: 400 },
};

// 對話框的送出處理綁在這裡，避免 index.html 出現行內腳本。
document.getElementById('token-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const dialog = document.getElementById('token-dialog');
  const token = dialog.querySelector('input[name=token]').value.trim();
  const includePrivate = dialog.querySelector('input[name=private]').checked;
  const remember = dialog.querySelector('input[name=remember]').checked;
  dialog.close();
  if (!token) return;
  if (remember) store.set(STORE.token, token); else store.del(STORE.token);
  runLiveScan(token, includePrivate);
});

boot();
