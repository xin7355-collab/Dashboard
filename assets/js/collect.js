/**
 * 把 GitHub 帳號的儲存用量收斂成一份「快照」JSON。
 *
 * 同一份程式碼跑在兩個地方：
 *   1. GitHub Actions (Node) —— 每日排程，只採集公開資料，commit 進 repo 當作歷史。
 *   2. 使用者瀏覽器 —— 帶使用者自己的 PAT，補上私人 repo 與帳單資料，永不離開瀏覽器。
 *
 * GitHub 的「空間」不是單一數字，而是好幾組互相獨立的額度，因此快照把來源拆開存：
 *   repoBytes      Git 內容本身 (repo.size，GitHub 定期估算，非即時)
 *   artifactBytes  Actions 產出的 artifacts —— 計入 Actions/Packages 共用儲存額度
 *   cacheBytes     Actions cache —— 每個 repo 各自 10 GB，不計入共用儲存
 *   releaseBytes   Release 附件 —— 不計入儲存額度，但會吃頻寬
 *   lfsBytes       Git LFS —— 獨立額度，REST API 沒有逐 repo 端點，只能從帳單拿總量
 */

import { GitHubClient } from './github.js';

export const SCHEMA_VERSION = 1;
const KB = 1024;

/**
 * @param {object}   opts
 * @param {string}   opts.login         GitHub 帳號
 * @param {string=}  opts.token         PAT；省略則只看得到公開資料
 * @param {boolean=} opts.includePrivate 是否納入私人 repo (需 token)
 * @param {number=}  opts.maxRepos      最多深掃幾個 repo（依體積由大到小）
 * @param {string=}  opts.source        'action' | 'browser'
 * @param {(msg:string, pct:number)=>void=} opts.onProgress
 */
export async function collectSnapshot(opts) {
  const {
    login, token = '', includePrivate = false,
    maxRepos = 300, source = 'browser', onProgress = () => {},
  } = opts;

  const gh = new GitHubClient({ token });
  const scope = includePrivate && token ? 'all' : 'public';

  onProgress('讀取帳號資料…', 5);
  const account = await fetchAccount(gh, login);

  onProgress('列出 repository…', 12);
  let repos = await fetchRepos(gh, login, Boolean(token));
  if (scope === 'public') repos = repos.filter((r) => !r.private);
  // 依 Git 體積排序，讓 maxRepos 的截斷砍掉的是最無關緊要的小 repo。
  repos.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  const deep = repos.slice(0, maxRepos);

  onProgress(`掃描 ${deep.length} 個 repository 的儲存明細…`, 20);
  let done = 0;
  const detailed = await gh.mapLimit(deep, async (repo) => {
    const detail = await scanRepo(gh, repo);
    done++;
    onProgress(`掃描 ${repo.name}…`, 20 + Math.round((done / deep.length) * 60));
    return detail;
  });

  onProgress('讀取帳單與額度…', 85);
  const billing = token ? await fetchBilling(gh, login) : null;
  const packages = token ? await fetchPackages(gh) : null;

  const totals = sumTotals(detailed, billing, packages);
  const reclaimable = buildReclaimable(detailed);

  onProgress('完成', 100);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    scope,
    source,
    account,
    totals,
    counts: {
      repos: repos.length,
      scanned: detailed.length,
      public: repos.filter((r) => !r.private).length,
      private: repos.filter((r) => r.private).length,
      forks: repos.filter((r) => r.fork).length,
      archived: repos.filter((r) => r.archived).length,
      artifacts: detailed.reduce((n, r) => n + r.artifactCount, 0),
      releases: detailed.reduce((n, r) => n + r.releaseCount, 0),
      packages: packages?.length ?? null,
    },
    repos: detailed.map(stripRepo),
    reclaimable,
    billing,
    rate: gh.rate,
    requestCount: gh.requestCount,
    errors: gh.errors,
  };
}

// ---------------------------------------------------------------- 帳號 / repo

async function fetchAccount(gh, login) {
  const u = (await gh.get('/user')) ?? (await gh.get(`/users/${login}`)) ?? {};
  return {
    login: u.login ?? login,
    name: u.name ?? null,
    avatarUrl: u.avatar_url ?? null,
    htmlUrl: u.html_url ?? `https://github.com/${login}`,
    createdAt: u.created_at ?? null,
    publicRepos: u.public_repos ?? null,
    // plan 只有帶 token 讀自己的 /user 時才會出現。
    plan: u.plan
      ? {
          name: u.plan.name,
          // plan.space 是早期遺留欄位，GitHub 已不再依它限制空間，僅供參考。
          legacySpaceBytes: typeof u.plan.space === 'number' ? u.plan.space * KB : null,
          privateRepos: u.plan.private_repos ?? null,
          collaborators: u.plan.collaborators ?? null,
        }
      : null,
  };
}

async function fetchRepos(gh, login, authed) {
  const path = authed
    ? '/user/repos?affiliation=owner&sort=updated'
    : `/users/${login}/repos?sort=updated`;
  return gh.paginate(path, { max: 1000 });
}

/** 對單一 repo 打 artifacts / cache / releases / LFS 四個面向。 */
async function scanRepo(gh, repo) {
  const full = repo.full_name;
  const [artifacts, cache, releases, usesLfs] = await Promise.all([
    gh.paginate(`/repos/${full}/actions/artifacts`, { max: 300, itemsAt: 'artifacts' }),
    gh.get(`/repos/${full}/actions/cache/usage`),
    gh.paginate(`/repos/${full}/releases`, { max: 100 }),
    detectLfs(gh, full),
  ]);

  const artifactItems = artifacts.map((a) => ({
    kind: 'artifact',
    repo: full,
    name: a.name,
    bytes: a.size_in_bytes ?? 0,
    createdAt: a.created_at ?? null,
    expiresAt: a.expires_at ?? null,
    expired: Boolean(a.expired),
    url: a.workflow_run?.id
      ? `https://github.com/${full}/actions/runs/${a.workflow_run.id}`
      : `https://github.com/${full}/actions`,
  }));

  const releaseBytes = releases.reduce(
    (n, rel) => n + (rel.assets ?? []).reduce((m, a) => m + (a.size ?? 0), 0), 0);
  const cacheBytes = cache?.active_caches_size_in_bytes ?? 0;

  return {
    name: repo.name,
    fullName: full,
    url: repo.html_url,
    private: Boolean(repo.private),
    fork: Boolean(repo.fork),
    archived: Boolean(repo.archived),
    // repo.size 的單位是 KB，且是 GitHub 定期估算的磁碟用量，不是即時值。
    sizeBytes: (repo.size ?? 0) * KB,
    artifactBytes: artifactItems.reduce((n, a) => n + a.bytes, 0),
    expiredArtifactBytes: artifactItems.filter((a) => a.expired).reduce((n, a) => n + a.bytes, 0),
    artifactCount: artifactItems.length,
    cacheBytes,
    cacheCount: cache?.active_caches_count ?? 0,
    releaseBytes,
    releaseCount: releases.length,
    usesLfs,
    pushedAt: repo.pushed_at ?? null,
    updatedAt: repo.updated_at ?? null,
    language: repo.language ?? null,
    stars: repo.stargazers_count ?? 0,
    openIssues: repo.open_issues_count ?? 0,
    defaultBranch: repo.default_branch ?? 'main',
    _artifactItems: artifactItems,
  };
}

/**
 * REST API 沒有「這個 repo 用了多少 LFS」的端點，只能從 .gitattributes 判斷有沒有在用。
 * 404 是絕大多數 repo 的正常情況，所以這裡直接吞掉，不污染錯誤清單。
 */
async function detectLfs(gh, full) {
  try {
    const res = await fetch(`https://api.github.com/repos/${full}/contents/.gitattributes`, {
      headers: {
        Accept: 'application/vnd.github.raw+json',
        ...(gh.token ? { Authorization: `Bearer ${gh.token}` } : {}),
      },
    });
    if (!res.ok) return false;
    return /filter\s*=\s*lfs/.test(await res.text());
  } catch { return false; }
}

function stripRepo(r) {
  const { _artifactItems, ...rest } = r;
  return rest;
}

// ---------------------------------------------------------------- 帳單

/**
 * GitHub 在 2025 年把個人帳號逐步遷到「enhanced billing platform」，
 * 新舊兩套端點在不同帳號上各自存在，所以先試新的、再退回舊的，兩套都失敗就顯示為「無資料」。
 * 兩者都需要 PAT 具備 read:user / Plan 讀取權限。
 */
async function fetchBilling(gh, login) {
  const now = new Date();
  const enhanced = await gh.get(
    `/users/${login}/settings/billing/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`);
  if (enhanced?.usageItems) return normaliseEnhanced(enhanced);

  const [storage, actions, packages] = await Promise.all([
    gh.get(`/users/${login}/settings/billing/shared-storage`),
    gh.get(`/users/${login}/settings/billing/actions`),
    gh.get(`/users/${login}/settings/billing/packages`),
  ]);
  if (!storage && !actions && !packages) return null;
  return {
    source: 'legacy',
    daysLeftInCycle: storage?.days_left_in_billing_cycle ?? null,
    sharedStorageGB: storage?.estimated_storage_for_month ?? null,
    paidStorageGB: storage?.estimated_paid_storage_for_month ?? null,
    lfsStorageGB: null,
    actions: actions
      ? {
          usedMinutes: actions.total_minutes_used ?? 0,
          paidMinutes: actions.total_paid_minutes_used ?? 0,
          includedMinutes: actions.included_minutes ?? null,
          breakdown: actions.minutes_used_breakdown ?? null,
        }
      : null,
    packages: packages
      ? {
          bandwidthGB: packages.total_gigabytes_bandwidth_used ?? 0,
          paidBandwidthGB: packages.total_paid_gigabytes_bandwidth_used ?? 0,
          includedGB: packages.included_gigabytes_bandwidth ?? null,
        }
      : null,
    netAmount: null,
    currency: 'USD',
  };
}

function normaliseEnhanced(payload) {
  const items = payload.usageItems ?? [];
  const sumBy = (pred, field = 'quantity') =>
    items.filter(pred).reduce((n, i) => n + (i[field] ?? 0), 0);
  const isProduct = (name) => (i) => (i.product ?? '').toLowerCase().includes(name);

  return {
    source: 'enhanced',
    daysLeftInCycle: null,
    // enhanced 的儲存量以 GB-day 計價，除以當月天數還原成「平均佔用 GB」。
    sharedStorageGB: round(sumBy(isProduct('storage')) / daysInThisMonth(), 3),
    paidStorageGB: null,
    lfsStorageGB: round(sumBy(isProduct('git lfs')) / daysInThisMonth(), 3) || null,
    actions: { usedMinutes: sumBy(isProduct('actions')), paidMinutes: null, includedMinutes: null, breakdown: null },
    packages: { bandwidthGB: sumBy(isProduct('packages')), paidBandwidthGB: null, includedGB: null },
    netAmount: round(items.reduce((n, i) => n + (i.netAmount ?? 0), 0), 2),
    currency: 'USD',
  };
}

async function fetchPackages(gh) {
  const types = ['container', 'npm', 'maven', 'rubygems', 'nuget', 'docker'];
  const all = [];
  for (const t of types) {
    const list = await gh.paginate(`/user/packages?package_type=${t}`, { max: 200 });
    all.push(...list.map((p) => ({
      name: p.name, type: t, visibility: p.visibility,
      versionCount: p.version_count ?? 0, url: p.html_url, updatedAt: p.updated_at,
    })));
  }
  return all;
}

// ---------------------------------------------------------------- 彙總

function sumTotals(repos, billing, packages) {
  const sum = (f) => repos.reduce((n, r) => n + (r[f] ?? 0), 0);
  const repoBytes = sum('sizeBytes');
  const artifactBytes = sum('artifactBytes');
  const cacheBytes = sum('cacheBytes');
  const releaseBytes = sum('releaseBytes');
  const lfsBytes = billing?.lfsStorageGB != null ? billing.lfsStorageGB * 1e9 : null;

  return {
    repoBytes, artifactBytes, cacheBytes, releaseBytes, lfsBytes,
    expiredArtifactBytes: sum('expiredArtifactBytes'),
    packagesCount: packages?.length ?? null,
    // 「總佔用」刻意排除 cache（可自動重建、不計入共用儲存額度），
    // 但仍在組成圖裡單獨顯示，才不會讓人誤以為那不用管。
    allBytes: repoBytes + artifactBytes + releaseBytes + (lfsBytes ?? 0),
  };
}

/** 挑出「刪掉就能立刻回收」的東西，由大到小排序。 */
function buildReclaimable(repos) {
  const items = [];
  for (const r of repos) {
    for (const a of r._artifactItems) {
      if (a.bytes <= 0) continue;
      items.push({
        ...a,
        reason: a.expired ? 'expired' : 'artifact',
        severity: a.expired ? 'critical' : 'warning',
      });
    }
    if (r.cacheBytes > 0) {
      items.push({
        kind: 'cache', repo: r.fullName,
        name: `${r.cacheCount} 個 Actions cache`,
        bytes: r.cacheBytes, createdAt: null, expiresAt: null, expired: false,
        url: `${r.url}/actions/caches`,
        reason: 'cache', severity: 'good',
      });
    }
  }
  items.sort((a, b) => b.bytes - a.bytes);
  return items.slice(0, 200);
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const daysInThisMonth = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).getUTCDate();
};
