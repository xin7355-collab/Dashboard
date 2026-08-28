/**
 * 刪除 GitHub 上可回收的資料（Actions artifacts 與 cache）。
 *
 * 這是整個儀表板唯一會改變狀態、而且無法復原的功能，所以規則寫死在這裡：
 *   - 一次只刪使用者明確勾選的項目，沒有「全部刪除」的捷徑
 *   - 逐筆回報成功或失敗，失敗一定要浮上來，絕不默默略過
 *   - 一筆失敗不中斷其餘，最後給完整結果讓人知道到底刪掉了什麼
 *   - 併發刻意壓低：刪除打的是寫入端點，太猛會撞上次級速率限制
 */

import { GitHubClient } from './github.js';

const ENDPOINTS = {
  artifact: (item) => `/repos/${item.repo}/actions/artifacts/${item.id}`,
  cache: (item) => `/repos/${item.repo}/actions/caches/${item.id}`,
};

/** 這一筆有沒有辦法刪？沒有 id 就只能看。 */
export function isDeletable(item) {
  return Boolean(item?.id) && Boolean(ENDPOINTS[item.kind]);
}

/**
 * @param {Array} items    要刪除的項目（必須先通過 isDeletable）
 * @param {string} token   使用者的 PAT，需具備 Actions: Read and write
 * @param {(done:number, total:number, item:object)=>void=} onProgress
 * @returns {Promise<{succeeded:Array, failed:Array, bytesFreed:number}>}
 */
export async function deleteItems(items, token, onProgress = () => {}) {
  const gh = new GitHubClient({ token, concurrency: 3 });
  const targets = items.filter(isDeletable);
  const succeeded = [];
  const failed = [];
  let done = 0;

  await gh.mapLimit(targets, async (item) => {
    const res = await gh.delete(ENDPOINTS[item.kind](item));
    done++;
    if (res.ok) succeeded.push(item);
    // 404 代表東西本來就不在了（過期被 GitHub 清掉、或別處已刪），
    // 使用者的目的其實已經達成，算成功比算失敗更貼近事實。
    else if (res.status === 404) succeeded.push({ ...item, alreadyGone: true });
    else failed.push({ ...item, error: res.message });
    onProgress(done, targets.length, item);
  });

  return {
    succeeded,
    failed,
    bytesFreed: succeeded.reduce((n, i) => n + (i.bytes ?? 0), 0),
    skipped: items.length - targets.length,
  };
}

/** 把一批項目整理成確認對話框要顯示的摘要。 */
export function summarise(items) {
  const by = (kind) => items.filter((i) => i.kind === kind);
  const artifacts = by('artifact');
  const caches = by('cache');
  const expired = artifacts.filter((i) => i.expired);
  const live = artifacts.filter((i) => !i.expired);
  const repos = [...new Set(items.map((i) => i.repo))];

  return {
    total: items.length,
    bytes: items.reduce((n, i) => n + (i.bytes ?? 0), 0),
    repos,
    artifacts: artifacts.length,
    caches: caches.length,
    expiredArtifacts: expired.length,
    // 未過期的 artifacts 是唯一真正會「失去東西」的類別，必須另外警告。
    liveArtifacts: live.length,
    liveArtifactBytes: live.reduce((n, i) => n + (i.bytes ?? 0), 0),
    undeletable: items.filter((i) => !isDeletable(i)).length,
  };
}
