#!/usr/bin/env node
/**
 * 從 Claude Code 的本機 session 紀錄計算訂閱方案用量。
 *
 *   node claude-usage.mjs [--json] [--window-hours 5] [--days 7]
 *
 * 資料來源是 ~/.claude/projects/<專案>/<session>.jsonl —— Claude Code 自己
 * 寫下的逐筆紀錄，每個 assistant 回合都帶著完整的 usage 欄位。這跟官方
 * /usage 指令的來源一致（文件寫明「由這台機器上的本地 session 歷史計算」），
 * 不碰任何未公開的網路端點，也不需要搬動任何憑證。
 *
 * 做得到與做不到，先講清楚：
 *   做得到 —— 精確算出任一時間窗內消耗的 token（分模型、分種類）
 *   做不到 —— 把它換算成「佔方案額度的百分比」。分母（方案上限的實際
 *             token 數）Anthropic 沒有公開，本機檔案裡也沒有。想要百分比
 *             就得用 --calibrate 從官方 /usage 的讀數反推一次。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = parseArgs(process.argv.slice(2));
const ROOT = argv.root ?? path.join(os.homedir(), '.claude', 'projects');
const WINDOW_HOURS = Number(argv['window-hours'] ?? 5);
const DAYS = Number(argv.days ?? 7);

if (!existsSync(ROOT)) {
  fail(`找不到 ${ROOT}。這支程式要在跑過 Claude Code 的那台機器上執行。`);
}

const entries = await collectEntries(ROOT);
if (!entries.length) fail(`${ROOT} 底下沒有任何可解析的 session 紀錄。`);

const now = Date.now();
const windows = buildSessionWindows(entries, WINDOW_HOURS);
const current = windows.at(-1);
const currentActive = current && now - current.start < WINDOW_HOURS * 3600_000;

const weekly = aggregate(entries.filter((e) => now - e.at < DAYS * 86400_000));
const all = aggregate(entries);

const report = {
  generatedAt: new Date(now).toISOString(),
  source: ROOT,
  sessionCount: new Set(entries.map((e) => e.sessionId)).size,
  projectCount: new Set(entries.map((e) => e.project)).size,
  entryCount: entries.length,
  earliest: new Date(Math.min(...entries.map((e) => e.at))).toISOString(),
  latest: new Date(Math.max(...entries.map((e) => e.at))).toISOString(),

  window: {
    hours: WINDOW_HOURS,
    active: Boolean(currentActive),
    startedAt: current ? new Date(current.start).toISOString() : null,
    // 視窗自第一則訊息起算，滿 WINDOW_HOURS 小時後結束，不是整點對齊。
    resetsAt: current ? new Date(current.start + WINDOW_HOURS * 3600_000).toISOString() : null,
    minutesLeft: currentActive
      ? Math.max(0, Math.round((current.start + WINDOW_HOURS * 3600_000 - now) / 60_000))
      : 0,
    usage: currentActive ? aggregate(current.entries) : aggregate([]),
  },

  period: { days: DAYS, usage: weekly },
  allTime: all,

  // 過去幾個已結束的視窗，用來看自己平常一個視窗燒多少。
  recentWindows: windows.slice(-10).map((w) => ({
    startedAt: new Date(w.start).toISOString(),
    entries: w.entries.length,
    billable: aggregate(w.entries).billableTokens,
  })),
};

if (argv.calibrate != null) {
  report.calibration = calibrate(report, Number(argv.calibrate), argv['calibrate-scope'] ?? 'window');
}

if (argv.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHuman(report);
}

// ---------------------------------------------------------------- 讀取

/** 掃過所有專案的所有 session 檔，抽出帶 usage 的 assistant 回合。 */
async function collectEntries(root) {
  const out = [];
  const projects = await readdir(root, { withFileTypes: true }).catch(() => []);

  for (const proj of projects) {
    const projPath = path.join(root, proj.name);
    const files = proj.isDirectory()
      ? (await readdir(projPath)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(projPath, f))
      : proj.name.endsWith('.jsonl') ? [projPath] : [];

    for (const file of files) {
      const info = await stat(file).catch(() => null);
      if (!info?.size) continue;
      const text = await readFile(file, 'utf8').catch(() => '');

      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue;
        // 整行壞掉就跳過。紀錄檔可能在寫入途中被讀到，一筆壞掉不該讓整份報告失敗。
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.type !== 'assistant') continue;

        const u = rec.message?.usage;
        if (!u) continue;
        const at = Date.parse(rec.timestamp);
        if (Number.isNaN(at)) continue;

        out.push({
          at,
          sessionId: rec.sessionId,
          project: path.basename(path.dirname(file)),
          model: rec.message.model ?? 'unknown',
          isSidechain: Boolean(rec.isSidechain),
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          thinking: u.output_tokens_details?.thinking_tokens ?? 0,
        });
      }
    }
  }

  out.sort((a, b) => a.at - b.at);
  return out;
}

// ---------------------------------------------------------------- 計算

/**
 * 把紀錄切成 5 小時的 session 視窗。
 *
 * Claude Code 的視窗是「從你那段時間的第一則訊息起算 N 小時」，不是整點
 * 對齊的固定格子——所以這裡照同樣規則重建：遇到超出目前視窗的紀錄，就以
 * 它為起點開一個新視窗。
 */
function buildSessionWindows(entries, hours) {
  const span = hours * 3600_000;
  const windows = [];
  for (const e of entries) {
    const last = windows.at(-1);
    if (!last || e.at - last.start >= span) windows.push({ start: e.at, entries: [e] });
    else last.entries.push(e);
  }
  return windows;
}

function aggregate(entries) {
  const sum = (f) => entries.reduce((n, e) => n + e[f], 0);
  const byModel = {};
  for (const e of entries) {
    const m = (byModel[e.model] ??= { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: 0 });
    m.calls++; m.input += e.input; m.output += e.output;
    m.cacheWrite += e.cacheWrite; m.cacheRead += e.cacheRead; m.thinking += e.thinking;
  }

  return {
    calls: entries.length,
    input: sum('input'),
    output: sum('output'),
    cacheWrite: sum('cacheWrite'),
    cacheRead: sum('cacheRead'),
    thinking: sum('thinking'),
    // 快取讀取的計價遠低於新輸入，混在一起看會嚴重高估用量，所以分開列，
    // 並以「不含 cacheRead」作為比較基準。
    billableTokens: sum('input') + sum('output') + sum('cacheWrite'),
    totalTokens: sum('input') + sum('output') + sum('cacheWrite') + sum('cacheRead'),
    byModel,
  };
}

/**
 * 用官方 /usage 顯示的百分比反推方案上限。
 *
 * 這是唯一誠實取得分母的辦法：Anthropic 沒有公開方案上限的 token 數，
 * 本機檔案裡也沒有。拿一次官方讀數當基準點，之後就能換算。
 * 校正值會隨方案與 Anthropic 的政策變動而失效，所以每次都附上校正時間。
 */
function calibrate(report, officialPercent, scope) {
  if (!(officialPercent > 0)) return { error: '校正百分比必須大於 0' };
  const used = scope === 'period' ? report.period.usage.billableTokens : report.window.usage.billableTokens;
  const implied = used / (officialPercent / 100);
  return {
    scope,
    officialPercent,
    observedTokens: used,
    impliedLimitTokens: Math.round(implied),
    note: '這是以單一讀數反推的估算值，不是官方公布的數字。方案或政策一變就要重新校正。',
    calibratedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- 輸出

function printHuman(r) {
  const n = (x) => x.toLocaleString('zh-TW');
  const bar = (frac, width = 28) => {
    const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
    return '█'.repeat(filled) + '░'.repeat(width - filled);
  };

  console.log();
  console.log(`  Claude Code 用量 · 讀自 ${r.sessionCount} 個 session / ${r.projectCount} 個專案`);
  console.log(`  紀錄範圍 ${r.earliest.slice(0, 16).replace('T', ' ')} ~ ${r.latest.slice(0, 16).replace('T', ' ')}`);
  console.log();

  const w = r.window;
  console.log(`  ── ${w.hours} 小時視窗 ${w.active ? '（進行中）' : '（已結束，下次送出會開新視窗）'}`);
  if (w.active) {
    console.log(`     開始於 ${w.startedAt.slice(11, 16)} · 還剩 ${Math.floor(w.minutesLeft / 60)} 小時 ${w.minutesLeft % 60} 分`);
  }
  console.log(`     計費 token  ${n(w.usage.billableTokens).padStart(12)}   (${w.usage.calls} 次呼叫)`);
  console.log(`       輸入      ${n(w.usage.input).padStart(12)}`);
  console.log(`       輸出      ${n(w.usage.output).padStart(12)}   其中思考 ${n(w.usage.thinking)}`);
  console.log(`       快取寫入  ${n(w.usage.cacheWrite).padStart(12)}`);
  console.log(`       快取讀取  ${n(w.usage.cacheRead).padStart(12)}   (計價低，不計入上面的計費 token)`);
  console.log();

  console.log(`  ── 最近 ${r.period.days} 天`);
  console.log(`     計費 token  ${n(r.period.usage.billableTokens).padStart(12)}   (${r.period.usage.calls} 次呼叫)`);
  for (const [model, m] of Object.entries(r.period.usage.byModel).sort((a, b) => b[1].output - a[1].output)) {
    const billable = m.input + m.output + m.cacheWrite;
    console.log(`       ${model.padEnd(20)} ${n(billable).padStart(12)}  (${m.calls} 次)`);
  }
  console.log();

  if (r.calibration?.impliedLimitTokens) {
    const c = r.calibration;
    const used = c.scope === 'period' ? r.period.usage.billableTokens : r.window.usage.billableTokens;
    const frac = used / c.impliedLimitTokens;
    console.log(`  ── 額度（以 ${c.officialPercent}% 的官方讀數校正）`);
    console.log(`     ${bar(frac)}  ${(frac * 100).toFixed(1)}%`);
    console.log(`     ${n(used)} / 約 ${n(c.impliedLimitTokens)} token`);
    console.log(`     ⚠ ${c.note}`);
  } else {
    console.log(`  ── 額度百分比`);
    console.log(`     無法計算：方案上限的 token 數 Anthropic 沒有公開，本機檔案也沒有。`);
    console.log(`     想要百分比，在 Claude Code 裡執行 /usage 看到讀數後，用：`);
    console.log(`       node claude-usage.mjs --calibrate <那個百分比數字>`);
  }

  console.log();
  if (r.recentWindows.length > 1) {
    console.log(`  ── 最近幾個視窗各燒了多少`);
    for (const win of r.recentWindows.slice(-6)) {
      console.log(`     ${win.startedAt.slice(5, 16).replace('T', ' ')}  ${n(win.billable).padStart(12)} token`);
    }
    console.log();
  }
}

// ---------------------------------------------------------------- 工具

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
