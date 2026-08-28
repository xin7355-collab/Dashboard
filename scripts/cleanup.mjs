#!/usr/bin/env node
/**
 * 自動清理 Actions artifacts。
 *
 *   node scripts/cleanup.mjs [--apply] [--older-than 30] [--keep-per-name 3]
 *
 * **預設是 dry-run。** 不加 --apply 就只列出會刪什麼，不會真的動手。
 * 這是刻意的：一支排程執行的刪除腳本，預設行為必須是安全的那一個。
 *
 * 三條規則，可在 config.json 的 cleanup 區塊調整：
 *   1. 已過期的 artifacts —— GitHub 遲早也會清，先清只是提早釋出空間
 *   2. 超過 olderThanDays 天的 artifacts
 *   3. 同名 artifact 只留最新 keepPerName 份
 *
 * 排除清單（excludeRepos / excludeArtifactNames）優先於上面三條，
 * 永遠不會被刪。
 */

import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectSnapshot } from '../assets/js/collect.js';
import { duplicateArtifacts } from '../assets/js/analysis.js';
import { deleteItems } from '../assets/js/cleanup.js';
import { bytes } from '../assets/js/format.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = parseArgs(process.argv.slice(2));
const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const rules = { ...config.cleanup, ...numericOverrides(argv) };

const token = process.env.DASHBOARD_TOKEN || process.env.GITHUB_TOKEN || '';
const login = config.account;
const apply = Boolean(argv.apply);

if (!token) fail('缺少 DASHBOARD_TOKEN，無法列出你的 repository。');
if (!login) fail('config.json 缺少 account 欄位。');
if (apply && !rules.enabled) {
  fail('config.json 的 cleanup.enabled 是 false。自動刪除必須明確開啟才會執行。');
}

console.log(`● 帳號 ${login} · ${apply ? '\x1b[31m實際刪除\x1b[0m' : 'dry-run（不會刪任何東西）'}`);
console.log(`  規則：過期的一律清 · 超過 ${rules.olderThanDays} 天 · 同名只留最新 ${rules.keepPerName} 份`);
if (rules.excludeRepos?.length) console.log(`  排除 repository：${rules.excludeRepos.join('、')}`);
if (rules.excludeArtifactNames?.length) console.log(`  排除名稱：${rules.excludeArtifactNames.join('、')}`);

const snap = await collectSnapshot({
  login, token,
  includePrivate: true,      // 清理要涵蓋所有 repo，但結果不會寫進任何檔案
  includeBilling: false,
  source: 'cleanup',
  onProgress: (msg, pct) => process.stdout.write(`\r  ${String(pct).padStart(3)}% ${msg.padEnd(48)}`),
});
process.stdout.write('\n');

const targets = pickTargets(snap, rules);

if (!targets.length) {
  console.log('\n✓ 沒有符合清理條件的 artifacts');
  await emitOutput('deleted', '0');
  await emitOutput('freed', '0 B');
  process.exit(0);
}

const totalBytes = targets.reduce((n, t) => n + t.bytes, 0);
console.log(`\n共 ${targets.length} 筆符合條件，合計 ${bytes(totalBytes)}：\n`);

for (const [reason, list] of groupBy(targets, (t) => t.cleanupReason)) {
  console.log(`  ${REASON_LABEL[reason]}：${list.length} 筆 · ${bytes(list.reduce((n, t) => n + t.bytes, 0))}`);
  for (const t of list.slice(0, 5)) {
    console.log(`    ${t.repo.split('/')[1]} / ${t.name} · ${bytes(t.bytes)}`);
  }
  if (list.length > 5) console.log(`    …另外 ${list.length - 5} 筆`);
}

if (!apply) {
  console.log('\n這是 dry-run。確認清單沒問題後，加上 --apply 才會真的刪除。');
  await emitOutput('deleted', '0');
  await emitOutput('freed', bytes(totalBytes));
  await emitOutput('dryrun', 'true');
  process.exit(0);
}

console.log('\n開始刪除…');
const result = await deleteItems(targets, token, (done, total) => {
  process.stdout.write(`\r  ${done} / ${total}`);
});
process.stdout.write('\n');

console.log(`\n✓ 刪除 ${result.succeeded.length} 筆，釋出 ${bytes(result.bytesFreed)}`);
if (result.failed.length) {
  console.error(`✗ ${result.failed.length} 筆失敗：`);
  for (const f of result.failed.slice(0, 10)) console.error(`  ${f.repo} / ${f.name} → ${f.error}`);
}

await emitOutput('deleted', String(result.succeeded.length));
await emitOutput('freed', bytes(result.bytesFreed));
await emitOutput('failed', String(result.failed.length));

// 有失敗就讓 workflow 紅燈，否則沒人會發現權杖權限不夠之類的問題。
if (result.failed.length) process.exit(1);

// ---------------------------------------------------------------- 選取邏輯

const REASON_LABEL = {
  expired: '已過期',
  old: `超過 ${rules.olderThanDays} 天`,
  duplicate: `同名超過最新 ${rules.keepPerName} 份`,
};

function pickTargets(snap, rules) {
  const artifacts = (snap.reclaimable ?? []).filter((i) => i.kind === 'artifact' && i.id);

  const excludedRepo = new Set(rules.excludeRepos ?? []);
  const excludedName = new Set(rules.excludeArtifactNames ?? []);
  const allowed = (a) =>
    !excludedRepo.has(a.repo) &&
    !excludedRepo.has(a.repo.split('/')[1]) &&
    !excludedName.has(a.name);

  const cutoff = Date.now() - rules.olderThanDays * 86400000;
  const chosen = new Map();   // 用 Map 去重：同一筆可能同時符合多條規則

  const add = (a, reason) => {
    if (!allowed(a) || chosen.has(a.id)) return;
    chosen.set(a.id, { ...a, cleanupReason: reason });
  };

  if (rules.includeExpired !== false) {
    for (const a of artifacts) if (a.expired) add(a, 'expired');
  }
  for (const a of artifacts) {
    if (a.createdAt && new Date(a.createdAt).getTime() < cutoff) add(a, 'old');
  }
  for (const a of duplicateArtifacts(snap, rules.keepPerName).stale) {
    if (a.id) add(a, 'duplicate');
  }

  return [...chosen.values()].sort((a, b) => b.bytes - a.bytes);
}

// ---------------------------------------------------------------- helpers

function groupBy(list, keyOf) {
  const m = new Map();
  for (const x of list) {
    const k = keyOf(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function numericOverrides(argv) {
  const out = {};
  if (argv['older-than']) out.olderThanDays = Number(argv['older-than']);
  if (argv['keep-per-name']) out.keepPerName = Number(argv['keep-per-name']);
  return out;
}

async function emitOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  await writeFile(file, `${key}=${value}\n`, { flag: 'a' });
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
