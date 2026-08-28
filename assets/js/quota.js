/**
 * 額度模型：把原始快照換算成「用了幾成、還剩多久、該擔心嗎」。
 *
 * GitHub 的空間不是一個總池，而是數個彼此獨立的額度。混在一起算會得到
 * 一個沒有意義的百分比，所以這裡一律逐項計算，各自帶自己的上限與說明。
 */

import { GB } from './format.js';

/** 嚴重度對應 dataviz 的 status 色票，永遠搭配文字標籤，不靠顏色單獨表意。 */
export const SEVERITY = {
  good: { label: '正常', rank: 0 },
  warning: { label: '注意', rank: 1 },
  serious: { label: '偏高', rank: 2 },
  critical: { label: '危險', rank: 3 },
};

function severityFor(pct, alerts) {
  if (pct == null) return 'good';
  if (pct >= alerts.criticalPercent) return 'critical';
  if (pct >= alerts.warnPercent) return 'serious';
  if (pct >= alerts.warnPercent * 0.66) return 'warning';
  return 'good';
}

/**
 * @returns {Array} 每個額度一個物件，`available:false` 代表需要 PAT 才看得到。
 */
/**
 * historyField 指出「這個額度該拿歷史裡的哪一條序列去預測」。
 * 拿總佔用的成長速度去撞共用儲存的上限，會得到一個看起來很嚇人但完全錯誤的日期，
 * 所以對不上序列的額度（每期重置的分鐘數、沒有逐 repo 歷史的項目）一律標成 null。
 */
export function deriveQuotas(snap, config) {
  const plan = config.quotas[config.plan] ?? config.quotas.free;
  const alerts = config.alerts;
  const adv = config.advisory;
  const b = snap.billing;
  const out = [];

  const push = (q) => {
    const pct = q.limit > 0 && q.used != null ? (q.used / q.limit) * 100 : null;
    out.push({ ...q, percent: pct, severity: q.available === false ? 'good' : severityFor(pct, alerts) });
  };

  // 1) Actions artifacts + Packages 共用的儲存額度 —— 最常爆掉的一項。
  push({
    id: 'shared-storage', historyField: 'artifactBytes',
    label: 'Actions 與 Packages 共用儲存',
    used: b?.sharedStorageGB != null ? b.sharedStorageGB * GB : snap.totals.artifactBytes,
    limit: plan.sharedStorageGB * GB,
    unit: 'bytes',
    available: true,
    estimated: b?.sharedStorageGB == null,
    note: b?.sharedStorageGB == null
      ? '未取得帳單資料，此處以 Actions artifacts 總量估算，未含 Packages。'
      : `帳單來源：${b.source === 'enhanced' ? '新版計費 API' : '舊版計費 API'}`,
    help: 'Artifacts 與 Packages 共用同一份儲存額度。刪掉過期 artifacts 是最快的回收手段。',
  });

  // 2) Git LFS —— REST API 沒有逐 repo 端點，只有帳單拿得到總量。
  push({
    id: 'lfs-storage', historyField: 'lfsBytes',
    label: 'Git LFS 儲存',
    used: b?.lfsStorageGB != null ? b.lfsStorageGB * GB : null,
    limit: plan.lfsStorageGB * GB,
    unit: 'bytes',
    available: b?.lfsStorageGB != null,
    note: b?.lfsStorageGB == null ? '需要具備帳單讀取權限的 PAT 才能取得。' : null,
    help: 'LFS 是獨立額度，不與 Actions 儲存共用。超額需另購 data pack。',
  });

  // 3) Actions 分鐘數（公開 repo 免費，只有私人 repo 計入）。
  push({
    id: 'actions-minutes', historyField: null,
    label: 'Actions 執行分鐘',
    used: b?.actions?.usedMinutes ?? null,
    limit: b?.actions?.includedMinutes ?? plan.actionsMinutes,
    unit: 'minutes',
    available: b?.actions?.usedMinutes != null,
    note: b?.actions?.usedMinutes == null ? '需要具備帳單讀取權限的 PAT 才能取得。' : '公開 repo 的用量不計費。',
    help: '每個計費週期重置。',
  });

  // 4) Packages 下載頻寬。
  push({
    id: 'packages-bandwidth', historyField: null,
    label: 'Packages 頻寬',
    used: b?.packages?.bandwidthGB != null ? b.packages.bandwidthGB * GB : null,
    limit: (b?.packages?.includedGB ?? plan.packagesBandwidthGB) * GB,
    unit: 'bytes',
    available: b?.packages?.bandwidthGB != null,
    note: b?.packages?.bandwidthGB == null ? '需要具備帳單讀取權限的 PAT 才能取得。' : null,
    help: '每個計費週期重置。',
  });

  // 5) 最肥的 repo vs GitHub 的 5 GB 建議上限 —— 不需要任何權限就算得出來。
  const biggest = [...(snap.repos ?? [])].sort((a, b2) => b2.sizeBytes - a.sizeBytes)[0];
  if (biggest) {
    push({
      id: 'largest-repo', historyField: null,
      label: `最大的 repository（${biggest.name}）`,
      used: biggest.sizeBytes,
      limit: adv.repoSoftLimitGB * GB,
      unit: 'bytes',
      available: true,
      note: `GitHub 建議單一 repo 保持在 ${adv.repoSoftLimitGB} GB 以下。`,
      help: '這是建議值不是硬限制，但超過會明顯拖慢 clone，且單次 push 超過 2 GB 會被拒絕。',
      link: biggest.url,
    });
  }

  // 6) 單一 repo 的 Actions cache 上限。
  const cacheHog = [...(snap.repos ?? [])].sort((a, b2) => b2.cacheBytes - a.cacheBytes)[0];
  if (cacheHog && cacheHog.cacheBytes > 0) {
    push({
      id: 'repo-cache', historyField: null,
      label: `Actions cache 最高的 repository（${cacheHog.name}）`,
      used: cacheHog.cacheBytes,
      limit: adv.cachePerRepoGB * GB,
      unit: 'bytes',
      available: true,
      note: `每個 repo 各有 ${adv.cachePerRepoGB} GB 的 cache 額度，滿了會自動淘汰最舊的。`,
      help: 'Cache 不計入儲存額度，也能自動重建，通常不需要手動清。',
      link: `${cacheHog.url}/actions/caches`,
    });
  }

  return out;
}

/**
 * 用最小平方法對歷史做線性外推，估「照這速度還有幾天撞上限」。
 *
 * 刻意只用最近 windowDays 天：儲存成長多半是階段性的，
 * 拿三個月前的斜率預測今天只會得到一個很有自信的錯誤答案。
 */
export function forecast(history, { field = 'allBytes', limit = null, windowDays = 30 } = {}) {
  const points = (history ?? [])
    .filter((h) => h[field] != null)
    .slice(-windowDays)
    .map((h) => ({ t: new Date(h.date).getTime() / 86400000, y: h[field] }));

  if (points.length < 3) {
    return { ok: false, reason: 'insufficient', pointCount: points.length };
  }

  const n = points.length;
  const meanT = points.reduce((s, p) => s + p.t, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  const varT = points.reduce((s, p) => s + (p.t - meanT) ** 2, 0);
  if (varT === 0) return { ok: false, reason: 'insufficient', pointCount: n };

  const slope = points.reduce((s, p) => s + (p.t - meanT) * (p.y - meanY), 0) / varT;
  const intercept = meanY - slope * meanT;

  // R² —— 斜率再漂亮，擬合度太差就不該拿來嚇人。
  const ssTot = points.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
  const ssRes = points.reduce((s, p) => s + (p.y - (intercept + slope * p.t)) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  const current = points[n - 1].y;
  const perDay = slope;
  let daysUntilFull = null;
  if (limit && perDay > 0 && current < limit) daysUntilFull = (limit - current) / perDay;
  else if (limit && current >= limit) daysUntilFull = 0;

  return {
    ok: true,
    perDay,
    r2,
    current,
    limit,
    daysUntilFull,
    // R² 低於 0.5 時斜率基本上是雜訊，UI 應該顯示「資料波動大，預測不可靠」。
    reliable: r2 >= 0.5 && n >= 7,
    pointCount: n,
    project: (dayOffset) => intercept + slope * (points[n - 1].t + dayOffset),
  };
}

/** 把「刪掉能回收多少」加總，並依類別分組。 */
export function reclaimSummary(snap) {
  const items = snap.reclaimable ?? [];
  const group = (reason) => {
    const sub = items.filter((i) => i.reason === reason);
    return { count: sub.length, bytes: sub.reduce((n, i) => n + i.bytes, 0) };
  };
  const expired = group('expired');
  const artifact = group('artifact');
  const cache = group('cache');
  return {
    expired, artifact, cache,
    // 「安全可回收」= 已過期的 artifacts + cache，刪掉不會失去任何無法重建的東西。
    safeBytes: expired.bytes + cache.bytes,
    totalBytes: expired.bytes + artifact.bytes + cache.bytes,
  };
}

/** 找出「很久沒動」的 repo，通常是可以歸檔或刪掉的。 */
export function staleRepos(snap, config) {
  const cutoff = Date.now() - config.alerts.staleRepoDays * 86400000;
  return (snap.repos ?? [])
    .filter((r) => r.pushedAt && new Date(r.pushedAt).getTime() < cutoff && !r.archived)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}
