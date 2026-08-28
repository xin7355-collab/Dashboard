/** 顯示層的格式化工具。全部純函式，Node 與瀏覽器共用。 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/**
 * 以 1000 為底格式化位元組。
 *
 * 刻意不用 1024：GitHub 的額度是以十進位 GB 標示的（免費方案 500 MB、
 * LFS 1 GB、單一 repo 建議 5 GB）。若用 1024 進位顯示，5 GB 的上限會被畫成
 * 「4.66 GB」，跟設定檔和 GitHub 頁面對不起來，比那點單位精確度更誤導人。
 */
export function bytes(n, digits = null) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n === 0) return '0 B';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log10(Math.abs(n)) / 3));
  const v = n / 1000 ** i;
  const d = digits ?? (i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2);
  return `${v.toFixed(d)} ${UNITS[i]}`;
}

/** 只回傳數值部分，供 hero 數字把單位另外排版。 */
export function bytesParts(n) {
  if (n == null || Number.isNaN(n)) return { value: '—', unit: '' };
  if (n === 0) return { value: '0', unit: 'B' };
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log10(Math.abs(n)) / 3));
  const v = n / 1000 ** i;
  return { value: v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2), unit: UNITS[i] };
}

export function num(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function percent(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

/** 有號差值，給 delta 用。 */
export function signedBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (Math.abs(n) < 1000) return '持平';
  return (n > 0 ? '+' : '−') + bytes(Math.abs(n));
}

export function date(iso, style = 'short') {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return style === 'long'
    ? d.toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' })
    : d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
}

/** 「3 天前」「5 個月前」。未來時間回傳「還有 N 天」。 */
export function relativeTime(iso) {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs)) return '—';
  const future = diffMs < 0;
  const days = Math.floor(Math.abs(diffMs) / 86400000);
  let text;
  if (days === 0) text = '今天';
  else if (days < 30) text = `${days} 天`;
  else if (days < 365) text = `${Math.floor(days / 30)} 個月`;
  else text = `${(days / 365).toFixed(1)} 年`;
  if (days === 0) return text;
  return future ? `還有 ${text}` : `${text}前`;
}

export function days(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n > 3650) return '10 年以上';
  if (n < 1) return '不到 1 天';
  if (n < 60) return `${Math.round(n)} 天`;
  if (n < 730) return `約 ${Math.round(n / 30)} 個月`;
  return `約 ${(n / 365).toFixed(1)} 年`;
}

export const GB = 1e9;
