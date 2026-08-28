/**
 * 極簡 GitHub REST 客戶端 —— 零相依、同構 (Node 18+ 與瀏覽器皆可)。
 *
 * 設計重點：
 *  - 每個端點都可能因為權限/方案/API 改版而失敗，因此一律「軟失敗」：
 *    回傳 null 並把原因記進 errors，讓儀表板能顯示「資料不完整」而不是整頁掛掉。
 *  - 自動處理 Link header 分頁與次級速率限制 (secondary rate limit) 的退避重試。
 */

const API = 'https://api.github.com';

export class GitHubClient {
  /**
   * @param {object}  opts
   * @param {string=} opts.token    個人存取權杖 (PAT)。省略則以未驗證身分呼叫，只看得到公開資料。
   * @param {number=} opts.concurrency 同時進行的請求數上限。
   */
  constructor({ token = '', concurrency = 6 } = {}) {
    this.token = token;
    this.concurrency = concurrency;
    this.errors = [];
    this.rate = null;      // { limit, remaining, reset }
    this.requestCount = 0;
  }

  get authenticated() { return Boolean(this.token); }

  /** 記錄一次端點失敗，供 UI 顯示「這塊資料抓不到，原因是…」。 */
  noteError(path, message, status = null) {
    this.errors.push({ path, message, status, at: new Date().toISOString() });
  }

  async #fetch(path, { retries = 3 } = {}) {
    const url = path.startsWith('http') ? path : API + path;
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    for (let attempt = 0; ; attempt++) {
      this.requestCount++;
      let res;
      try {
        res = await fetch(url, { headers });
      } catch (err) {
        // 網路層失敗：退避重試，用完就放棄。
        if (attempt >= retries) throw new Error(`network: ${err.message}`);
        await sleep(2 ** attempt * 500);
        continue;
      }

      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining !== null) {
        this.rate = {
          limit: Number(res.headers.get('x-ratelimit-limit')),
          remaining: Number(remaining),
          reset: Number(res.headers.get('x-ratelimit-reset')) * 1000,
        };
      }

      // 403/429 且帶 Retry-After 或主速率限制歸零 → 等待後重試。
      if ((res.status === 403 || res.status === 429) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const primaryExhausted = remaining === '0';
        if (retryAfter || primaryExhausted) {
          const waitMs = retryAfter
            ? retryAfter * 1000
            : Math.max(0, (this.rate?.reset ?? 0) - Date.now()) + 1000;
          // 主限制歸零時可能要等很久，超過 60 秒就不硬等，直接回報。
          if (waitMs <= 60_000) { await sleep(waitMs); continue; }
        }
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status}: ${firstLine(body)}`);
        err.status = res.status;
        throw err;
      }

      return { res, body: await res.json() };
    }
  }

  /**
   * 取單一資源。失敗時回傳 fallback 並記錄原因。
   *
   * quietStatuses 列出「這個狀態碼是預期內的，不算故障」的情況，例如查空
   * repository 的檔案樹必然回 409。把預期內的狀況記成錯誤，會讓真正的問題
   * 被雜訊淹沒，也會誤觸儀表板的「資料不完整」警告。
   */
  async get(path, fallback = null, { quietStatuses = [] } = {}) {
    try {
      const { body } = await this.#fetch(path);
      return body;
    } catch (err) {
      if (!quietStatuses.includes(err.status)) {
        this.noteError(path, err.message, err.status ?? null);
      }
      return fallback;
    }
  }

  /**
   * 刪除單一資源。
   *
   * 刻意不走 get()/paginate() 的「軟失敗」路徑：刪除的每一次失敗都必須讓
   * 呼叫端看見並回報給使用者，絕不能默默吞掉讓人以為刪掉了。
   *
   * @returns {Promise<{ok: boolean, status: number|null, message: string|null}>}
   */
  async delete(path) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    try {
      this.requestCount++;
      const res = await fetch(API + path, { method: 'DELETE', headers });
      if (res.status === 204 || res.status === 200) return { ok: true, status: res.status, message: null };
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, message: describeDeleteError(res.status, firstLine(body)) };
    } catch (err) {
      return { ok: false, status: null, message: `網路錯誤：${err.message}` };
    }
  }

  /** 依 Link header 逐頁取完整清單。 */
  async paginate(path, { max = 1000, itemsAt = null } = {}) {
    const out = [];
    let next = path.includes('per_page=') ? path : path + (path.includes('?') ? '&' : '?') + 'per_page=100';
    try {
      while (next && out.length < max) {
        const { res, body } = await this.#fetch(next);
        const items = itemsAt ? (body?.[itemsAt] ?? []) : body;
        if (!Array.isArray(items)) break;
        out.push(...items);
        next = parseNextLink(res.headers.get('link'));
      }
    } catch (err) {
      this.noteError(path, err.message, err.status ?? null);
    }
    return out.slice(0, max);
  }

  /** 有上限的平行 map —— 幾十個 repo 各打三四個端點時，序列會慢到無法接受。 */
  async mapLimit(items, fn) {
    const out = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, items.length || 1) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return out;
  }
}

function parseNextLink(link) {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/** 把 HTTP 狀態碼翻成使用者看得懂、而且知道下一步怎麼做的訊息。 */
function describeDeleteError(status, detail) {
  if (status === 403) return '權限不足：權杖需要 Actions 的「Read and write」權限（目前只有唯讀）。';
  if (status === 404) return '找不到（可能已經被刪除或過期清掉了）。';
  if (status === 401) return '權杖無效或已過期。';
  return `HTTP ${status}：${detail}`;
}

function firstLine(text) {
  try { return (JSON.parse(text).message ?? text).toString().slice(0, 200); }
  catch { return text.slice(0, 200); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
