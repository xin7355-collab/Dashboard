/** 儀表板的渲染層：把快照 + 額度模型畫成畫面。 */

import * as fmt from './format.js';
import { deriveQuotas, forecast, reclaimSummary, staleRepos, SEVERITY } from './quota.js';
import {
  el, svg, txt, sparkline, trendChart, stackedBar, barList, meter,
  statusBadge, chartCard, dataTable, emptyState,
} from './charts.js';
import { isDeletable, summarise } from './cleanup.js';

/** 空間組成的顏色指派：依「實體」固定，不隨排序或篩選改變。 */
const COMPOSITION = [
  { key: 'repoBytes',     label: 'Git 內容',           color: 'var(--series-1)' },
  { key: 'artifactBytes', label: 'Actions artifacts',  color: 'var(--series-2)' },
  { key: 'cacheBytes',    label: 'Actions cache',      color: 'var(--series-3)' },
  { key: 'releaseBytes',  label: 'Release 附件',        color: 'var(--series-4)', onFill: '#3d2a00' },
  { key: 'lfsBytes',      label: 'Git LFS',            color: 'var(--series-5)', onFill: '#4a1128' },
];

export function render(root, ctx) {
  const { snapshot: snap, history, config } = ctx;
  const quotas = deriveQuotas(snap, config);
  const reclaim = reclaimSummary(snap);
  const view = sliceHistory(history, ctx.rangeDays);

  root.replaceChildren();
  root.append(...banners(snap, quotas, ctx));
  root.append(hero(snap, view, quotas, reclaim, ctx));
  root.append(kpiRow(snap, view));

  const grid = el('div', { class: 'grid' });
  grid.append(
    trendCard(snap, view, quotas, config, ctx),
    compositionCard(snap),
    quotaCard(quotas),
    repoRankCard(snap),
    billingCard(snap, ctx),
    reclaimCard(snap, reclaim, ctx),
    healthCard(snap, config),
  );
  root.append(grid);
}

// ---------------------------------------------------------------- 橫幅

function banners(snap, quotas, ctx) {
  const out = [];

  if (snap.demo) {
    out.push(banner('demo', 'warn',
      '這是示範資料',
      '用來預覽版面用的假資料。第一次 GitHub Actions 排程跑完（或你按下「即時掃描」）之後，就會換成你帳號的真實數字。'));
  }

  const breached = quotas.filter((q) => q.available !== false && q.percent != null && q.percent >= ctx.config.alerts.warnPercent);
  if (breached.length) {
    out.push(banner('critical', 'alert',
      `${breached.length} 項額度已超過 ${ctx.config.alerts.warnPercent}%`,
      breached.map((q) => `${q.label} ${q.percent.toFixed(0)}%`).join('、')));
  }

  if (snap.errors?.length) {
    const denied = snap.errors.filter((e) => e.status === 403 || e.status === 404).length;
    out.push(banner('partial', 'alert',
      `有 ${snap.errors.length} 個端點沒取到資料，畫面上的數字並不完整`,
      denied
        ? '多數是權限不足（403/404）。用具備 repo 與帳單讀取權限的 PAT 執行「即時掃描」可以補齊。'
        : snap.errors[0].message));
  }

  if (snap.scope === 'public' && !ctx.hasToken) {
    out.push(banner('info', 'info',
      '目前只顯示公開資料',
      '私人 repository、Git LFS 與帳單用量需要你自己的存取權杖。點右上角「即時掃描」貼上 PAT，資料只會留在這台裝置的瀏覽器裡，不會寫進 repo。'));
  }

  return out;
}

function banner(kind, icon, title, body) {
  const paths = {
    warn: 'M12 3 22 20H2z M12 9v4 M12 16.5v.5',
    alert: 'M12 3 22 20H2z M12 9v4 M12 16.5v.5',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 11v6 M12 7.5v.5',
  };
  return el('div', { class: `banner ${kind}` }, [
    svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'aria-hidden': 'true' }, [
      svg('path', { d: paths[icon], 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    ]),
    el('div', { class: 'body' }, [
      el('strong', { text: title }),
      el('p', { text: body }),
    ]),
  ]);
}

// ---------------------------------------------------------------- Hero

function hero(snap, view, quotas, reclaim, ctx) {
  const total = snap.totals.allBytes;
  const { value, unit } = fmt.bytesParts(total);
  const series = view.map((h) => h.allBytes);
  const delta = deltaOf(view, 'allBytes');

  // 「最需要注意的」= 使用率最高、且拿得到資料的那一項。
  const worst = quotas
    .filter((q) => q.available !== false && q.percent != null)
    .sort((a, b) => b.percent - a.percent)[0];

  // 預測一定要跑在與該額度同一條序列上，否則就是拿 A 的成長去撞 B 的上限。
  const worstForecast = worst?.historyField
    ? forecast(view, { field: worst.historyField, limit: worst.limit })
    : { ok: false, reason: 'no-series' };

  return el('section', { class: 'hero' }, [
    // ── 總佔用 ──────────────────────────────────────────────
    el('div', {}, [
      el('div', { class: 'eyebrow' }, [
        txt('總佔用空間'),
        el('span', { class: 'badge neutral', text: snap.scope === 'all' ? '含私人' : '僅公開' }),
      ]),
      el('div', { class: 'hero-figure' }, [
        txt(value),
        el('span', { class: 'unit', text: unit }),
      ]),
      el('div', { class: 'hero-meta' }, [
        deltaEl(delta, ctx.rangeLabel),
        series.length > 1 ? sparkline(series, { width: 90, height: 28 }) : null,
      ]),
      el('div', { class: 'meter-foot', style: 'margin-top: 8px' }, [
        txt(`${fmt.num(snap.counts.repos)} 個 repository · Git 內容 ${fmt.bytes(snap.totals.repoBytes)}`),
      ]),
    ]),

    // ── 最緊繃的額度 ────────────────────────────────────────
    el('div', {}, [
      el('div', { class: 'eyebrow', text: '最需要注意的額度' }),
      worst
        ? el('div', {}, [
            meter(worst),
            el('div', { class: 'meter-foot', style: 'margin-top: 10px; line-height: 1.6' }, [
              txt(forecastSentence(worst, worstForecast)),
            ]),
          ])
        : emptyState('沒有可計算的額度'),
    ]),

    // ── 可回收 ──────────────────────────────────────────────
    el('div', {}, [
      el('div', { class: 'eyebrow', text: '可安全回收' }),
      el('div', { class: 'hero-figure', style: 'font-size: 34px' }, [
        txt(fmt.bytesParts(reclaim.safeBytes).value),
        el('span', { class: 'unit', style: 'font-size: 16px', text: fmt.bytesParts(reclaim.safeBytes).unit }),
      ]),
      el('div', { class: 'meter-foot', style: 'margin-top: 10px; line-height: 1.6' }, [
        txt(reclaim.safeBytes > 0
          ? `${reclaim.expired.count} 個過期 artifacts（${fmt.bytes(reclaim.expired.bytes)}）＋ ${reclaim.cache.count} 組 cache（${fmt.bytes(reclaim.cache.bytes)}）。刪掉不會失去任何無法重建的東西。`
          : '目前沒有可以直接回收的東西，很乾淨。'),
      ]),
      reclaim.safeBytes > 0
        ? el('button', {
            class: 'btn', style: 'margin-top: 12px', type: 'button',
            text: '看可回收清單 ↓',
            onclick: () => document.getElementById('reclaim-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
          })
        : null,
    ]),
  ]);
}

function deltaOf(view, field) {
  if (view.length < 2) return null;
  return view.at(-1)[field] - view[0][field];
}

function deltaEl(delta, period) {
  if (delta == null) return el('span', { class: 'delta flat', text: '尚無比較基準' });
  const dir = Math.abs(delta) < 1024 ? 'flat' : delta > 0 ? 'up' : 'down';
  const arrow = { up: '↑', down: '↓', flat: '→' }[dir];
  return el('span', { class: `delta ${dir}` }, [
    txt(`${arrow} ${fmt.signedBytes(delta)}`),
    el('span', { class: 'period', text: ` ${period}` }),
  ]);
}

// ---------------------------------------------------------------- 統計磚

function kpiRow(snap, view) {
  const tiles = [
    { key: 'repoBytes', label: 'Git 內容', color: 'var(--series-1)',
      note: `${snap.counts.repos} 個 repository` },
    { key: 'artifactBytes', label: 'Actions artifacts', color: 'var(--series-2)',
      note: snap.totals.expiredArtifactBytes > 0
        ? `${snap.counts.artifacts} 個，其中 ${fmt.bytes(snap.totals.expiredArtifactBytes)} 已過期`
        : `${snap.counts.artifacts} 個` },
    { key: 'cacheBytes', label: 'Actions cache', color: 'var(--series-3)',
      note: '可自動重建' },
    { key: 'releaseBytes', label: 'Release 附件', color: 'var(--series-4)',
      note: `${snap.counts.releases} 個 release` },
  ];

  return el('div', { class: 'kpi-row' }, tiles.map((t) => {
    const v = snap.totals[t.key] ?? 0;
    const parts = fmt.bytesParts(v);
    const series = view.map((h) => h[t.key]).filter((n) => n != null);
    return el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label' }, [
        el('span', { class: 'swatch', style: `background: ${t.color}` }),
        txt(t.label),
      ]),
      el('div', { class: 'stat-value' }, [
        txt(parts.value),
        el('span', { class: 'unit', text: parts.unit }),
      ]),
      el('div', { class: 'stat-foot' }, [
        el('span', { class: 'stat-note', text: t.note }),
        series.length > 1 ? sparkline(series, { color: t.color }) : null,
      ]),
    ]);
  }));
}

// ---------------------------------------------------------------- 趨勢

/** 趨勢圖可切換的序列。門檻線只會畫在「量得起來是同一回事」的那條上。 */
const TREND_SERIES = [
  { field: 'allBytes', label: '總佔用' },
  { field: 'repoBytes', label: 'Git 內容' },
  { field: 'artifactBytes', label: 'Artifacts' },
  { field: 'cacheBytes', label: 'Cache' },
  { field: 'releaseBytes', label: 'Release' },
];

function forecastSentence(quota, fc) {
  if (!quota) return '沒有可計算的額度。';
  if (!quota.historyField) {
    return ['actions-minutes', 'packages-bandwidth'].includes(quota.id)
      ? '這項每個計費週期重置，不做長期預估。'
      : '這項沒有逐日的歷史序列，因此不做用滿預估。';
  }
  if (!fc.ok) return '累積至少 3 天的快照之後就能預估用滿時間。';
  if (!fc.reliable) return `近 ${fc.pointCount} 天成長波動大（R²=${fc.r2.toFixed(2)}），預測不可靠。`;
  if (fc.perDay <= 0) return `近 ${fc.pointCount} 天沒有成長，目前沒有用滿的風險。`;
  if (fc.daysUntilFull == null) return `近 ${fc.pointCount} 天每天增加 ${fmt.bytes(fc.perDay)}。`;
  return `照最近 ${fc.pointCount} 天的速度（${fmt.bytes(fc.perDay)}/天），${fmt.days(fc.daysUntilFull)}後用滿。`;
}

function trendCard(snap, view, quotas, config, ctx) {
  const usable = quotas.filter((q) => q.available !== false && q.percent != null);
  const worst = [...usable].sort((a, b) => b.percent - a.percent)[0];

  // 一打開就直接顯示最該擔心的那條序列；沒什麼好擔心的話才退回總佔用。
  const initial = (worst?.historyField && worst.percent >= config.alerts.warnPercent)
    ? worst.historyField : 'allBytes';

  const holder = el('div', { class: 'col-8', style: 'min-width: 0' });

  const build = (field) => {
    const meta = TREND_SERIES.find((t) => t.field === field) ?? TREND_SERIES[0];
    const points = view
      .filter((h) => h[field] != null)
      .map((h) => ({ date: h.date, value: h[field] }));

    // 只有「量的是同一件事」的額度才配當門檻線。
    const quota = usable.find((q) => q.historyField === field) ?? null;
    const fc = forecast(view, { field, limit: quota?.limit ?? null });

    let projection = [];
    if (fc.ok && fc.reliable && fc.perDay > 0) {
      const horizon = Math.min(
        config.alerts.forecastHorizonDays,
        fc.daysUntilFull != null && fc.daysUntilFull > 0 ? Math.ceil(fc.daysUntilFull * 1.15) : 30);
      const step = Math.max(1, Math.round(horizon / 6));
      const lastDate = new Date(points.at(-1).date).getTime();
      for (let d = step; d <= horizon; d += step) {
        projection.push({
          date: new Date(lastDate + d * 86400000).toISOString().slice(0, 10),
          value: fc.project(d),
        });
      }
    }

    const chart = points.length >= 2
      ? trendChart({
          points, projection,
          threshold: quota ? { value: quota.limit, label: `${quota.label} 上限` } : null,
          seriesName: meta.label,
          ariaLabel: `${meta.label} 的每日趨勢與預估`,
        })
      : emptyState(
          `目前只有 ${points.length} 天的快照`,
          '排程每天會累積一筆。滿 3 天之後這裡就會出現趨勢線與用滿預估。');

    const subtitle = points.length < 2
      ? '累積至少 3 天的快照後會顯示成長速度與用滿預估'
      : quota
        ? forecastSentence(quota, fc)
        : (fc.ok && fc.reliable && fc.perDay > 0
            ? `近 ${fc.pointCount} 天每天增加 ${fmt.bytes(fc.perDay)}（R²=${fc.r2.toFixed(2)}）。這條序列沒有對應的單一額度，因此不畫門檻線。`
            : `這條序列沒有對應的單一額度，因此不畫門檻線。`);

    const selector = el('div', { class: 'viewtoggle series-select', role: 'group', 'aria-label': '選擇要看的序列' },
      TREND_SERIES.map((t) => el('button', {
        type: 'button', text: t.label,
        'aria-pressed': String(t.field === field),
        onclick: () => rebuild(t.field),
      })));

    return chartCard({
      title: '成長趨勢與用滿預估',
      subtitle,
      span: '',
      extra: selector,
      chart,
      table: dataTable(
        [
          { label: '日期', key: 'date' },
          { label: 'Git 內容', key: 'repoBytes', numeric: true, render: (r) => fmt.bytes(r.repoBytes) },
          { label: 'Artifacts', key: 'artifactBytes', numeric: true, render: (r) => fmt.bytes(r.artifactBytes) },
          { label: 'Cache', key: 'cacheBytes', numeric: true, render: (r) => fmt.bytes(r.cacheBytes) },
          { label: 'Release', key: 'releaseBytes', numeric: true, render: (r) => fmt.bytes(r.releaseBytes) },
          { label: '總計', key: 'allBytes', numeric: true, render: (r) => fmt.bytes(r.allBytes) },
        ],
        [...view].reverse(), { sortable: true, cap: true }),
    });
  };

  // 切換序列會整張卡重繪（標題、門檻線、預測全都要跟著換），所以由 holder 換內容。
  const rebuild = (field) => holder.replaceChildren(build(field));
  rebuild(initial);

  return holder;
}

// ---------------------------------------------------------------- 組成

function compositionCard(snap) {
  const segments = COMPOSITION
    .map((c) => ({ ...c, value: snap.totals[c.key] ?? 0 }))
    .filter((c) => c.value > 0);
  const total = segments.reduce((n, s) => n + s.value, 0);

  // 圖例帶數值 —— 淺色模式有幾個色階低於 3:1 對比，規範要求以可見標籤補償。
  const legend = el('div', { class: 'legend' }, segments.map((s) =>
    el('div', { class: 'legend-item' }, [
      el('span', { class: 'legend-key', style: `background: ${s.color}` }),
      txt(s.label),
      el('span', { class: 'val', text: fmt.bytes(s.value) }),
    ])));

  // 這裡的合計會比 hero 的「總佔用」多出 cache —— cache 能自動重建、也不計入
  // 任何付費額度，所以不算進總佔用，但仍要顯示，否則人家會以為那不用管。
  const cacheBytes = snap.totals.cacheBytes ?? 0;
  const subtitle = total <= 0
    ? '尚無資料'
    : cacheBytes > 0
      ? `合計 ${fmt.bytes(total)}，其中 ${fmt.bytes(cacheBytes)} 是可自動重建的 cache，不計入上方的總佔用`
      : `合計 ${fmt.bytes(total)}`;

  return chartCard({
    title: '空間組成',
    subtitle,
    span: 'col-4',
    chart: el('div', {}, [stackedBar(segments), legend]),
    table: dataTable(
      [
        { label: '來源', key: 'label', cls: 'name' },
        { label: '大小', key: 'value', numeric: true, render: (r) => fmt.bytes(r.value) },
        { label: '占比', key: 'pct', numeric: true, render: (r) => fmt.percent((r.value / total) * 100) },
      ],
      segments, { sortable: true }),
  });
}

// ---------------------------------------------------------------- 排行

function repoRankCard(snap) {
  const repos = [...(snap.repos ?? [])]
    .map((r) => ({
      ...r,
      totalBytes: r.sizeBytes + r.artifactBytes + r.releaseBytes,
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes);

  const shown = repos.slice(0, 12);
  const rest = repos.slice(12);
  const items = shown.map((r) => ({ label: r.name, value: r.totalBytes, href: r.url, note: 'Git + artifacts + release' }));
  // 尾巴摺成「其他」而不是繼續長出更多列。
  if (rest.length) {
    items.push({ label: `其他 ${rest.length} 個`, value: rest.reduce((n, r) => n + r.totalBytes, 0), note: '合計' });
  }

  return chartCard({
    title: 'Repository 佔用排行',
    subtitle: repos.length > 12 ? `前 12 名，其餘 ${rest.length} 個合併顯示` : `共 ${repos.length} 個`,
    span: 'col-8',
    chart: barList(items, { max: 13 }),
    table: dataTable(
      [
        { label: 'Repository', key: 'name', cls: 'name',
          render: (r) => el('a', { href: r.url, target: '_blank', rel: 'noopener', text: r.name }) },
        { label: 'Git', key: 'sizeBytes', numeric: true, render: (r) => fmt.bytes(r.sizeBytes) },
        { label: 'Artifacts', key: 'artifactBytes', numeric: true, render: (r) => fmt.bytes(r.artifactBytes) },
        { label: 'Cache', key: 'cacheBytes', numeric: true, render: (r) => fmt.bytes(r.cacheBytes) },
        { label: 'Release', key: 'releaseBytes', numeric: true, render: (r) => fmt.bytes(r.releaseBytes) },
        { label: '合計', key: 'totalBytes', numeric: true, render: (r) => fmt.bytes(r.totalBytes) },
      ],
      repos, { sortable: true, cap: true }),
  });
}

// ---------------------------------------------------------------- 額度

function quotaCard(quotas) {
  return el('section', { class: 'card col-12' }, [
    el('div', { class: 'card-head' }, [el('h2', { class: 'card-title', text: '額度總覽' })]),
    el('p', { class: 'card-sub', text: 'GitHub 的空間不是一個總池，而是數個彼此獨立的額度。混在一起算只會得到一個沒有意義的百分比，所以這裡逐項計算。' }),
    el('div', { class: 'meter-grid' }, quotas.map((q) => {
      const m = meter(q);
      if (q.help) m.append(el('div', { class: 'meter-foot', style: 'color: var(--text-muted); margin-top: 2px', text: q.help }));
      return m;
    })),
  ]);
}

// ---------------------------------------------------------------- 可回收

const RECLAIM_LABEL = { expired: '過期 artifact', artifact: 'artifact', cache: 'Actions cache' };

const uidOf = (i) => `${i.kind}:${i.repo}:${i.id ?? i.name}`;

function reclaimCard(snap, reclaim, ctx) {
  const items = snap.reclaimable ?? [];
  const selected = new Set();

  const card = el('section', { class: 'card col-12', id: 'reclaim-card' });
  const body = el('div');

  if (!items.length) {
    card.append(
      el('div', { class: 'card-head' }, [
        el('h2', { class: 'card-title', text: '可回收空間' }),
        el('span', { class: 'spacer' }),
        statusBadge('good', '無待清理'),
      ]),
      el('p', { class: 'card-sub', text: 'Actions artifacts 與 cache 都在合理範圍內。' }),
      emptyState('沒有可回收的項目'),
    );
    return card;
  }

  // ── 工具列（只有拿得到寫入權杖時才出現）──────────────────────────
  const countLabel = el('span', { class: 'meter-foot', text: '尚未選取任何項目' });
  const deleteBtn = el('button', {
    class: 'btn danger', type: 'button', disabled: 'true',
    text: '刪除選取項目',
  });

  const refreshToolbar = () => {
    const chosen = items.filter((i) => selected.has(uidOf(i)));
    const bytes = chosen.reduce((n, i) => n + i.bytes, 0);
    countLabel.textContent = chosen.length
      ? `已選 ${chosen.length} 項，共 ${fmt.bytes(bytes)}`
      : '尚未選取任何項目';
    if (chosen.length) deleteBtn.removeAttribute('disabled');
    else deleteBtn.setAttribute('disabled', 'true');
  };

  const setSelection = (predicate) => {
    selected.clear();
    items.filter(predicate).filter(isDeletable).forEach((i) => selected.add(uidOf(i)));
    body.querySelectorAll('input[type=checkbox][data-uid]').forEach((cb) => {
      cb.checked = selected.has(cb.dataset.uid);
    });
    refreshToolbar();
  };

  const toolbar = el('div', { class: 'toolbar' }, [
    el('button', { class: 'btn', type: 'button', text: '選取已過期',
      onclick: () => setSelection((i) => i.expired) }),
    el('button', { class: 'btn', type: 'button', text: '選取所有 cache',
      onclick: () => setSelection((i) => i.kind === 'cache') }),
    el('button', { class: 'btn', type: 'button', text: '清除選取',
      onclick: () => setSelection(() => false) }),
    el('span', { class: 'spacer' }),
    countLabel,
    deleteBtn,
  ]);

  deleteBtn.addEventListener('click', () => {
    const chosen = items.filter((i) => selected.has(uidOf(i)));
    if (chosen.length) openConfirmDialog(chosen, ctx, () => setSelection(() => false));
  });

  // ── 表格 ──────────────────────────────────────────────────────
  const table = el('table', { class: 'data' });
  const thead = el('thead', {}, [
    el('tr', {}, [
      ctx.canDelete ? el('th', { class: 'check-col', scope: 'col' }, [
        el('span', { class: 'sr-only', text: '選取' }),
      ]) : null,
      el('th', { scope: 'col', text: '項目' }),
      el('th', { scope: 'col', text: 'Repository' }),
      el('th', { scope: 'col', text: '類型' }),
      el('th', { class: 'num', scope: 'col', text: '大小' }),
      el('th', { scope: 'col', text: '最後使用' }),
      el('th', { scope: 'col', text: '到期' }),
    ].filter(Boolean)),
  ]);

  const tbody = el('tbody', {}, items.map((item) => {
    const deletable = isDeletable(item);
    const cb = ctx.canDelete
      ? el('input', {
          type: 'checkbox', 'data-uid': uidOf(item),
          'aria-label': `選取 ${item.name}`,
          ...(deletable ? {} : { disabled: 'true', title: '這一筆缺少可刪除的識別碼' }),
          onchange: (e) => {
            if (e.target.checked) selected.add(uidOf(item));
            else selected.delete(uidOf(item));
            refreshToolbar();
          },
        })
      : null;

    return el('tr', {}, [
      ctx.canDelete ? el('td', { class: 'check-col' }, [cb]) : null,
      el('td', { class: 'name' }, [
        el('a', { href: item.url, target: '_blank', rel: 'noopener', text: item.name }),
      ]),
      el('td', { text: item.repo.split('/')[1] ?? item.repo }),
      el('td', {}, [statusBadge(item.severity, RECLAIM_LABEL[item.reason] ?? item.reason)]),
      el('td', { class: 'num', text: fmt.bytes(item.bytes) }),
      el('td', { text: fmt.relativeTime(item.lastAccessedAt ?? item.createdAt) }),
      el('td', { text: item.expired ? '已過期' : (item.expiresAt ? fmt.relativeTime(item.expiresAt) : '—') }),
    ].filter(Boolean));
  }));

  table.append(thead, tbody);
  body.append(el('div', { class: 'table-wrap scroll-cap' }, [table]));

  card.append(
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '可回收空間' }),
      el('span', { class: 'spacer' }),
      reclaim.safeBytes > 0
        ? statusBadge('warning', `可釋出 ${fmt.bytes(reclaim.safeBytes)}`)
        : statusBadge('good', '無待清理'),
    ]),
    el('p', { class: 'card-sub',
      text: '過期的 artifacts 與 Actions cache 刪掉都不會失去無法重建的東西。' }),
    ctx.canDelete
      ? toolbar
      : el('div', { class: 'banner info', style: 'margin: 0 0 14px' }, [
          svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'aria-hidden': 'true' }, [
            svg('path', { d: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 11v6 M12 7.5v.5', 'stroke-linecap': 'round' }),
          ]),
          el('div', { class: 'body' }, [
            el('strong', { text: '想直接在這裡刪除？' }),
            el('p', { text: '按右上角「即時掃描」貼上權杖即可。刪除需要權杖具備 Actions 的「Read and write」權限（唯讀權杖只能看）。' }),
          ]),
        ]),
    body,
  );
  return card;
}

/**
 * 刪除確認對話框。
 *
 * 刪除無法復原，所以這裡不做「你確定嗎？」這種空話，而是把「到底會失去什麼」
 * 攤開講：幾筆、多大、散在哪些 repo，其中有幾筆是還沒過期的 artifacts
 * （唯一真的會失去東西的類別，另外用紅字警告）。
 */
function openConfirmDialog(chosen, ctx, onDone) {
  const sum = summarise(chosen);
  const dialog = el('dialog', { class: 'sheet' });

  const line = (label, value) => el('div', {
    style: 'display:flex; justify-content:space-between; gap:12px; padding:6px 0; border-bottom:1px solid var(--border)',
  }, [
    el('span', { style: 'color: var(--text-secondary)', text: label }),
    el('span', { style: 'font-weight:600; font-variant-numeric:tabular-nums', text: value }),
  ]);

  const progress = el('p', { class: 'card-sub', style: 'margin:12px 0 0', hidden: 'true' });
  const confirmBtn = el('button', { class: 'btn danger', type: 'button', text: `刪除這 ${sum.total} 項` });
  const cancelBtn = el('button', { class: 'btn', type: 'button', text: '取消',
    onclick: () => dialog.close() });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.setAttribute('disabled', 'true');
    cancelBtn.setAttribute('disabled', 'true');
    progress.hidden = false;
    progress.textContent = '刪除中…';

    const result = await ctx.onDelete(chosen, (done, total) => {
      progress.textContent = `刪除中… ${done} / ${total}`;
    });

    dialog.close();
    onDone();
    showResult(result);
  });

  dialog.append(
    el('div', { class: 'sheet-head' }, [
      el('h2', { text: '確認刪除' }),
    ]),
    el('div', { class: 'sheet-body' }, [
      el('p', { text: '這個動作無法復原。以下是會被刪掉的東西：' }),
      el('div', { style: 'margin-top:12px' }, [
        line('項目數', `${sum.total} 筆`),
        line('釋出空間', fmt.bytes(sum.bytes)),
        line('涉及 repository', `${sum.repos.length} 個`),
        sum.expiredArtifacts ? line('已過期的 artifacts', `${sum.expiredArtifacts} 筆`) : null,
        sum.caches ? line('Actions cache', `${sum.caches} 筆（會自動重建）`) : null,
      ].filter(Boolean)),
      sum.liveArtifacts
        ? el('div', { class: 'banner critical', style: 'margin:14px 0 0' }, [
            svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'aria-hidden': 'true' }, [
              svg('path', { d: 'M12 3 22 20H2z M12 9v4 M12 16.5v.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
            ]),
            el('div', { class: 'body' }, [
              el('strong', { text: `其中 ${sum.liveArtifacts} 筆是還沒過期的 artifacts（${fmt.bytes(sum.liveArtifactBytes)}）` }),
              el('p', { text: '這些是還在保留期內的建置產物，刪掉之後只能重跑 workflow 才會有。cache 和已過期的項目則沒有這個問題。' }),
            ]),
          ])
        : null,
      sum.undeletable
        ? el('p', { class: 'card-sub', style: 'margin-top:10px',
            text: `有 ${sum.undeletable} 筆缺少識別碼會被略過（通常是舊版快照的資料，重新掃描一次就好）。` })
        : null,
      progress,
    ]),
    el('div', { class: 'sheet-foot' }, [cancelBtn, confirmBtn]),
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

/** 刪除結果：成功幾筆、失敗幾筆、失敗的原因逐筆列出。 */
function showResult(result) {
  const dialog = el('dialog', { class: 'sheet' });
  const ok = result.succeeded.length;
  const bad = result.failed.length;

  dialog.append(
    el('div', { class: 'sheet-head' }, [
      el('h2', { text: bad ? '部分項目刪除失敗' : '刪除完成' }),
    ]),
    el('div', { class: 'sheet-body' }, [
      el('p', { text: `成功刪除 ${ok} 筆，釋出 ${fmt.bytes(result.bytesFreed)}。` }),
      bad
        ? el('div', { style: 'margin-top:12px' }, [
            el('strong', { text: `${bad} 筆失敗：` }),
            el('ul', { style: 'margin:8px 0 0; padding-left:18px; color:var(--text-secondary)' },
              result.failed.slice(0, 8).map((f) =>
                el('li', { style: 'margin-bottom:4px' }, [
                  el('code', { text: f.name }),
                  txt(` — ${f.error}`),
                ]))),
          ])
        : null,
      el('p', { class: 'card-sub', style: 'margin-top:14px',
        text: '畫面上的數字會在下一次掃描後更新。' }),
    ]),
    el('div', { class: 'sheet-foot' }, [
      el('button', { class: 'btn primary', type: 'button', text: '知道了',
        onclick: () => dialog.close() }),
    ]),
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

// ---------------------------------------------------------------- 健康度

function healthCard(snap, config) {
  const stale = new Set(staleRepos(snap, config).map((r) => r.fullName));
  const rows = [...(snap.repos ?? [])].sort((a, b) => b.sizeBytes - a.sizeBytes);
  const softLimit = config.advisory.repoSoftLimitGB * 1e9;

  const flagsOf = (r) => {
    const flags = [];
    if (r.sizeBytes >= softLimit) flags.push(['critical', `超過 ${config.advisory.repoSoftLimitGB} GB 建議值`]);
    else if (r.sizeBytes >= softLimit / 2) flags.push(['serious', '體積偏大']);
    if (stale.has(r.fullName)) flags.push(['warning', `逾 ${config.alerts.staleRepoDays} 天未更新`]);
    if (r.archived) flags.push(['good', '已歸檔']);
    if (r.fork) flags.push(['good', 'fork']);
    if (r.usesLfs) flags.push(['warning', '使用 LFS']);
    return flags;
  };

  return chartCard({
    title: 'Repository 健康度',
    subtitle: `體積偏大、久未更新、使用 LFS 的 repository 會在這裡被標出來（點欄位標題可排序）`,
    span: 'col-12',
    chart: dataTable(
      [
        { label: 'Repository', key: 'name', cls: 'name',
          render: (r) => el('a', { href: r.url, target: '_blank', rel: 'noopener', text: r.name }) },
        { label: '語言', key: 'language', render: (r) => r.language ?? '—' },
        { label: 'Git 體積', key: 'sizeBytes', numeric: true, render: (r) => fmt.bytes(r.sizeBytes) },
        { label: '最後 push', key: 'pushedAt', render: (r) => fmt.relativeTime(r.pushedAt) },
        { label: '狀態', key: '_flags',
          render: (r) => {
            const flags = flagsOf(r);
            if (!flags.length) return el('span', { class: 'muted', text: '正常' });
            return el('span', { style: 'display: inline-flex; gap: 4px; flex-wrap: wrap' },
              flags.map(([sev, label]) => statusBadge(sev, label)));
          } },
      ],
      rows, { sortable: true, cap: true }),
  });
}

// ---------------------------------------------------------------- 帳單

function billingCard(snap, ctx) {
  const b = snap.billing;
  const body = b
    ? el('div', {}, [
        b.unitsResolved === false
          ? el('p', { class: 'card-sub', style: 'color: var(--serious)',
              text: '新版計費 API 這次回傳了無法辨識的計量單位，以下的儲存數字可能差一個數量級，請以 GitHub 帳單頁面為準。' })
          : null,
        row('資料來源', b.source === 'enhanced' ? '新版計費 API' : '舊版計費 API'),
        b.daysLeftInCycle != null ? row('本期剩餘', `${b.daysLeftInCycle} 天`) : null,
        b.sharedStorageGB != null ? row('共用儲存', fmt.bytes(b.sharedStorageGB * 1e9)) : null,
        b.lfsStorageGB != null ? row('Git LFS', fmt.bytes(b.lfsStorageGB * 1e9)) : null,
        b.actions?.usedMinutes != null ? row('Actions 分鐘', `${fmt.num(b.actions.usedMinutes)} 分`) : null,
        b.packages?.bandwidthGB != null ? row('Packages 頻寬', fmt.bytes(b.packages.bandwidthGB * 1e9)) : null,
        b.netAmount != null ? row('本期預估費用', `${b.currency} ${b.netAmount.toFixed(2)}`) : null,
      ].filter(Boolean))
    : emptyState('尚未取得帳單資料',
        ctx.hasToken
          ? '你的權杖沒有帳單讀取權限，或這個帳號還在舊版計費平台上而端點已停用。'
          : '需要一組具備帳單讀取權限的個人存取權杖。');

  return el('section', { class: 'card col-4' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: '帳單用量' }),
      el('span', { class: 'spacer' }),
      b ? null : el('span', { class: 'badge neutral', text: '需要權杖' }),
    ]),
    el('p', { class: 'card-sub', text: '帳單是帳號層級的私人資料，只在「即時掃描」時於你的瀏覽器抓取，不會寫進 repository' }),
    body,
  ]);
}

function row(label, value) {
  return el('div', {
    style: 'display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: 13px',
  }, [
    el('span', { style: 'color: var(--text-secondary)', text: label }),
    el('span', { style: 'font-weight: 600; font-variant-numeric: tabular-nums', text: value }),
  ]);
}

// ---------------------------------------------------------------- 工具

function sliceHistory(history, days) {
  if (!days || days === 'all') return history;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const sliced = history.filter((h) => h.date >= cutoff);
  // 篩選後至少留兩點，否則趨勢卡會整片空掉，反而更難懂。
  return sliced.length >= 2 ? sliced : history.slice(-2);
}
