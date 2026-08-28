#!/usr/bin/env node
/**
 * 每日快照產生器 —— 由 GitHub Actions 排程執行。
 *
 *   node scripts/snapshot.mjs [--scope public|all] [--out data]
 *
 * 預設只採集「公開」資料，因為產出的 JSON 會 commit 進 repo。
 * 私人 repo 與帳單資料只在使用者瀏覽器帶自己的 PAT 時才抓取，永不落地。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectSnapshot } from '../assets/js/collect.js';
import { deriveQuotas, forecast, reclaimSummary } from '../assets/js/quota.js';
import { bytes, days as fmtDays } from '../assets/js/format.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = parseArgs(process.argv.slice(2));

const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const outDir = path.join(root, argv.out ?? 'data');
const scope = argv.scope ?? 'public';
const token = process.env.DASHBOARD_TOKEN || process.env.GITHUB_TOKEN || '';
const login = argv.login ?? config.account;

if (!login) fail('config.json 缺少 account 欄位，且未提供 --login。');

console.log(`● 帳號 ${login} · 範圍 ${scope} · ${token ? '已帶 token' : '未帶 token（僅公開資料）'}`);

const snap = await collectSnapshot({
  login,
  token,
  includePrivate: scope === 'all',
  source: 'action',
  onProgress: (msg, pct) => process.stdout.write(`\r  ${String(pct).padStart(3)}% ${msg.padEnd(50)}`),
});
process.stdout.write('\n');

if (!snap.repos.length && snap.errors.length) {
  console.error('✗ 一個 repository 都沒抓到，且有錯誤，視為失敗：');
  for (const e of snap.errors.slice(0, 5)) console.error(`  ${e.path} → ${e.message}`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

// --- latest.json：完整快照 -------------------------------------------------
await writeJson(path.join(outDir, 'latest.json'), snap);

// --- history.json：只留輕量的每日彙總，才不會讓 repo 隨時間爆炸 -----------
const historyPath = path.join(outDir, 'history.json');
const history = existsSync(historyPath) ? JSON.parse(await readFile(historyPath, 'utf8')) : [];
const today = snap.generatedAt.slice(0, 10);
const entry = {
  date: today,
  repoBytes: snap.totals.repoBytes,
  artifactBytes: snap.totals.artifactBytes,
  expiredArtifactBytes: snap.totals.expiredArtifactBytes,
  cacheBytes: snap.totals.cacheBytes,
  releaseBytes: snap.totals.releaseBytes,
  lfsBytes: snap.totals.lfsBytes,
  allBytes: snap.totals.allBytes,
  repoCount: snap.counts.repos,
};

// 同一天重跑就覆蓋，避免手動觸發把當天灌成好幾筆。
const merged = [...history.filter((h) => h.date !== today), entry].sort((a, b) => a.date.localeCompare(b.date));
const cutoff = new Date(Date.now() - config.history.retainDays * 86400000).toISOString().slice(0, 10);
await writeJson(historyPath, merged.filter((h) => h.date >= cutoff));

// --- 額度檢查：輸出給 workflow 決定要不要開 Issue -------------------------
const quotas = deriveQuotas(snap, config).filter((q) => q.available && q.percent != null);
const breached = quotas.filter((q) => q.percent >= config.alerts.warnPercent);
const fc = forecast(merged, { limit: null });
const reclaim = reclaimSummary(snap);

console.log('');
console.log(`  Git 內容        ${bytes(snap.totals.repoBytes).padStart(10)}  (${snap.counts.repos} 個 repo)`);
console.log(`  Artifacts       ${bytes(snap.totals.artifactBytes).padStart(10)}  (${snap.counts.artifacts} 個)`);
console.log(`  Actions cache   ${bytes(snap.totals.cacheBytes).padStart(10)}`);
console.log(`  Release 附件    ${bytes(snap.totals.releaseBytes).padStart(10)}  (${snap.counts.releases} 個 release)`);
console.log(`  ─────────────────────────`);
console.log(`  可安全回收      ${bytes(reclaim.safeBytes).padStart(10)}`);
if (fc.ok) console.log(`  近期成長        ${bytes(fc.perDay).padStart(10)}/天  (R²=${fc.r2.toFixed(2)}${fc.reliable ? '' : '，波動大'})`);
if (snap.errors.length) console.log(`  ⚠ ${snap.errors.length} 個端點取用失敗（儀表板會標示資料不完整）`);

const alertLines = breached.map((q) => {
  const f = forecast(merged, { field: 'allBytes', limit: q.limit });
  const eta = f.ok && f.reliable && f.daysUntilFull != null ? `，預估 ${fmtDays(f.daysUntilFull)}後用滿` : '';
  return `- **${q.label}**：已用 ${q.percent.toFixed(1)}%（${bytes(q.used)} / ${bytes(q.limit)}）${eta}`;
});

await emitOutput('breached', breached.length ? 'true' : 'false');
await emitOutput('summary', alertLines.join('\n'));
await emitOutput('reclaimable', bytes(reclaim.safeBytes));

console.log(breached.length ? `\n✗ ${breached.length} 項額度超過 ${config.alerts.warnPercent}% 門檻` : '\n✓ 所有額度都在門檻內');

// ---------------------------------------------------------------- helpers

async function writeJson(file, data) {
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`  → 寫入 ${path.relative(root, file)}`);
}

/** 寫進 $GITHUB_OUTPUT 供後續 step 使用；本機執行時靜靜略過。 */
async function emitOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = `__EOF_${key}_${Math.random().toString(36).slice(2)}__`;
  await writeFile(file, `${key}<<${delim}\n${value}\n${delim}\n`, { flag: 'a' });
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }
