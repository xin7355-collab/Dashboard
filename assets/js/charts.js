/**
 * SVG 圖表元件。零相依、手寫，因為版面細節（2px 表面間隙、4px 圓角資料端、
 * 只在放得下時才標字）是圖表可讀性的關鍵，而通用套件不會替你顧這些。
 *
 * 共通規則：
 *   - 線寬 2px、格線 1px 實線且退到背景、長條最粗 24px
 *   - 相鄰色塊之間留 2px 的「表面色間隙」，而不是描邊
 *   - 文字一律用文字色票，不穿資料色；顏色只由旁邊的色塊承擔
 *   - 每張圖都有等價的表格檢視（呼叫端負責掛上）
 */

import * as fmt from './format.js';

const NS = 'http://www.w3.org/2000/svg';
const GAP = 2;          // 表面間隙
const RADIUS = 4;       // 資料端圓角

export function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) node.append(c);
  return node;
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;   // 一律走 textContent，資料是不可信的
    else if (k === 'html') node.innerHTML = v;     // 只用在我們自己寫死的圖示
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) if (c != null) node.append(c);
  return node;
}

/** 量測文字寬度 —— 用來決定標籤放不放得進色塊，放不下就不放，絕不裁切。 */
const _canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const _ctx = _canvas?.getContext('2d');
export function textWidth(text, font = '600 11px system-ui') {
  if (!_ctx) return text.length * 6.5;
  _ctx.font = font;
  return _ctx.measureText(text).width;
}

/** 取整成好看的刻度值（1 / 2 / 5 × 10ⁿ）。 */
function niceStep(raw) {
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}

/**
 * 產生刻度。最後一格一定 >= max —— 呼叫端拿最後一個刻度當座標軸上限，
 * 若刻度停在 max 以下，超過的資料（例如高於所有實測值的額度門檻線）會被整條吃掉。
 */
function ticks(min, max, count = 4) {
  if (max <= min) return [min, min + 1];
  const step = niceStep((max - min) / count);
  const out = [];
  for (let v = Math.floor(min / step) * step; ; v += step) {
    out.push(v);
    if (v >= max || out.length > 20) break;
  }
  return out;
}

/**
 * 監看容器寬度變化並重繪 —— SVG 用固定 viewBox 縮放會讓文字跟著變形。
 *
 * `keep` 是重繪時必須保留的節點（提示框）。少了它，第一次繪製就會把
 * 呼叫端先掛上去的提示框一起清掉，之後 hover 是對著一個游離節點寫入，
 * 不會報錯但永遠不顯示。
 */
function responsive(container, draw, keep = []) {
  let lastWidth = 0;
  const render = () => {
    const w = Math.max(240, Math.floor(container.clientWidth));
    if (w === lastWidth) return;
    lastWidth = w;
    container.replaceChildren(...keep);
    draw(w, container);
  };
  render();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(render);
    ro.observe(container);
    container._ro = ro;
  }
  return container;
}

// ==========================================================================
// 迷你走勢線（統計磚用）
// ==========================================================================

export function sparkline(values, { width = 76, height = 26, color = 'var(--series-1)' } = {}) {
  const clean = (values ?? []).filter((v) => Number.isFinite(v));
  if (clean.length < 2) return svg('svg', { class: 'spark', width, height, 'aria-hidden': 'true' });

  const min = Math.min(...clean), max = Math.max(...clean);
  const span = max - min || 1;
  const pad = 3;
  const x = (i) => (i / (clean.length - 1)) * (width - pad * 2) + pad;
  const y = (v) => height - pad - ((v - min) / span) * (height - pad * 2);
  const d = clean.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  return svg('svg', { class: 'spark', width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' }, [
    svg('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: .45 }),
    // 末點加 2px 表面色環，跨線時仍然看得清楚。
    svg('circle', { cx: x(clean.length - 1), cy: y(clean.at(-1)), r: 3, fill: color, stroke: 'var(--surface-1)', 'stroke-width': 2 }),
  ]);
}

// ==========================================================================
// 趨勢折線 + 線性外推 + 額度門檻線
// ==========================================================================

/**
 * @param {object} o
 * @param {Array<{date:string, value:number}>} o.points 實際資料
 * @param {Array<{date:string, value:number}>=} o.projection 外推段（虛線）
 * @param {{value:number,label:string}=} o.threshold 額度上限
 * @param {string=} o.seriesName 單一序列時不需要圖例，標題已經說明畫的是什麼
 */
export function trendChart(o) {
  const container = el('div', { class: 'chart' });
  const tip = el('div', { class: 'tooltip', role: 'status' });
  container.append(tip);

  responsive(container, (W) => {
    const points = o.points ?? [];
    const proj = o.projection ?? [];
    if (points.length < 2) { container.append(emptyState('資料點不足，至少要 2 天才畫得出趨勢')); return; }

    const H = o.height ?? 210;
    const M = { top: 14, right: 58, bottom: 26, left: 8 };
    const plotW = W - M.left - M.right;
    const plotH = H - M.top - M.bottom;

    const all = [...points, ...proj];
    const t0 = new Date(points[0].date).getTime();
    const t1 = new Date(all.at(-1).date).getTime();
    const tSpan = t1 - t0 || 1;

    const maxVal = Math.max(...all.map((p) => p.value), o.threshold?.value ?? 0);
    const yTicks = ticks(0, maxVal * 1.08, 4);
    const yMax = yTicks.at(-1);

    const x = (d) => M.left + ((new Date(d).getTime() - t0) / tSpan) * plotW;
    const y = (v) => M.top + plotH - (v / yMax) * plotH;

    const root = svg('svg', {
      width: W, height: H, viewBox: `0 0 ${W} ${H}`,
      role: 'img', 'aria-label': o.ariaLabel ?? '儲存用量趨勢',
    });

    // 格線：一階退到背景的實線，永遠不用虛線。
    for (const t of yTicks) {
      root.append(svg('line', { x1: M.left, x2: M.left + plotW, y1: y(t), y2: y(t), class: 'gridline' }));
      root.append(svg('text', {
        x: M.left + plotW + 8, y: y(t) + 4, class: 'axis-label',
      }, [txt(fmt.bytes(t, 0))]));
    }

    // 面積：序列色 10% 的淡淡一層，不是飽和色塊。
    const lineD = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    root.append(svg('path', {
      d: `${lineD} L${x(points.at(-1).date).toFixed(1)},${y(0)} L${x(points[0].date).toFixed(1)},${y(0)} Z`,
      fill: 'var(--series-1)', opacity: .1,
    }));
    root.append(svg('path', {
      d: lineD, fill: 'none', stroke: 'var(--series-1)',
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));

    // 外推段：虛線是「這不是實測值」最直白的訊號。
    if (proj.length) {
      const projD = [points.at(-1), ...proj]
        .map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
      root.append(svg('path', {
        d: projD, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2,
        'stroke-dasharray': '5 5', 'stroke-linecap': 'round', opacity: .55,
      }));
    }

    // 額度門檻線。
    if (o.threshold && o.threshold.value <= yMax) {
      const ty = y(o.threshold.value);
      root.append(svg('line', {
        x1: M.left, x2: M.left + plotW, y1: ty, y2: ty,
        stroke: 'var(--critical)', 'stroke-width': 1.5, 'stroke-dasharray': '4 4',
      }));
      root.append(svg('text', {
        x: M.left + 4, y: ty - 6, class: 'axis-label', style: 'fill: var(--critical); font-weight: 600',
      }, [txt(o.threshold.label)]));
    }

    // X 軸日期依寬度決定幾格：窄螢幕放 4 個一定會疊字。
    const xTickCount = Math.min(W < 430 ? 2 : W < 700 ? 3 : 4, all.length - 1);
    for (let i = 0; i <= xTickCount; i++) {
      const p = all[Math.round((i / xTickCount) * (all.length - 1))];
      root.append(svg('text', {
        x: Math.min(M.left + plotW, Math.max(M.left + 14, x(p.date))),
        y: H - 8, class: 'axis-label', 'text-anchor': i === 0 ? 'start' : i === xTickCount ? 'end' : 'middle',
      }, [txt(fmt.date(p.date))]));
    }

    // 末點：直接標值（規範要求「有選擇地」標，端點正是該標的那一個）。
    const last = points.at(-1);
    root.append(svg('circle', {
      cx: x(last.date), cy: y(last.value), r: 4.5,
      fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2,
    }));

    // 互動層：十字準星鎖定 X，讀者瞄的是日期而不是那條 2px 的線。
    const cross = svg('line', {
      y1: M.top, y2: M.top + plotH, stroke: 'var(--axis)', 'stroke-width': 1, opacity: 0,
    });
    const focusDot = svg('circle', {
      r: 4.5, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2, opacity: 0,
    });
    root.append(cross, focusDot);

    const hit = svg('rect', {
      x: M.left, y: M.top, width: plotW, height: plotH, fill: 'transparent',
      style: 'cursor: crosshair', tabindex: '0', role: 'application',
      'aria-label': '用左右方向鍵瀏覽各日資料',
    });
    root.append(hit);

    let focusIndex = points.length - 1;
    const showAt = (idx) => {
      const p = all[Math.max(0, Math.min(all.length - 1, idx))];
      const isProj = idx >= points.length;
      const px = x(p.date), py = y(p.value);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('opacity', .7);
      focusDot.setAttribute('cx', px); focusDot.setAttribute('cy', py); focusDot.setAttribute('opacity', 1);

      tip.replaceChildren(
        el('div', { class: 'tt-title', text: fmt.date(p.date, 'long').split(' ')[0] + (isProj ? '（預估）' : '') }),
        el('div', { class: 'tt-row' }, [
          el('span', { class: 'tt-key', style: 'background: var(--series-1)' }),
          el('span', { class: 'tt-name', text: o.seriesName ?? '總佔用' }),
          el('span', { class: 'tt-val', text: fmt.bytes(p.value) }),
        ]),
      );
      tip.dataset.show = 'true';
      const tw = tip.offsetWidth || 150;
      tip.style.left = `${Math.max(0, Math.min(W - tw, px - tw / 2))}px`;
      tip.style.top = `${Math.max(0, py - tip.offsetHeight - 12)}px`;
    };
    const hide = () => { tip.dataset.show = 'false'; cross.setAttribute('opacity', 0); focusDot.setAttribute('opacity', 0); };

    const nearest = (clientX) => {
      const rect = root.getBoundingClientRect();
      const rel = ((clientX - rect.left) / rect.width) * W;
      let best = 0, bestD = Infinity;
      all.forEach((p, i) => { const d = Math.abs(x(p.date) - rel); if (d < bestD) { bestD = d; best = i; } });
      return best;
    };

    hit.addEventListener('pointermove', (e) => { focusIndex = nearest(e.clientX); showAt(focusIndex); });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => showAt(focusIndex));
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      focusIndex = Math.max(0, Math.min(all.length - 1, focusIndex + (e.key === 'ArrowRight' ? 1 : -1)));
      showAt(focusIndex);
    });

    container.append(root);
  }, [tip]);

  return container;
}

// ==========================================================================
// 水平堆疊條（部分對整體）
// ==========================================================================

/**
 * @param {Array<{label:string, value:number, color:string}>} segments
 */
export function stackedBar(segments, { height = 44 } = {}) {
  const container = el('div', { class: 'chart' });
  const tip = el('div', { class: 'tooltip' });
  container.append(tip);

  responsive(container, (W) => {
    const live = segments.filter((s) => s.value > 0);
    const total = live.reduce((n, s) => n + s.value, 0);
    if (!total) { container.append(emptyState('目前沒有佔用任何空間')); return; }

    const root = svg('svg', {
      width: W, height, viewBox: `0 0 ${W} ${height}`,
      role: 'img', 'aria-label': '儲存空間組成',
    });

    // 每段之間讓出 2px 的表面色間隙，由幾何造成，不畫描邊。
    const gapTotal = GAP * (live.length - 1);
    const usable = Math.max(0, W - gapTotal);
    let cursor = 0;

    live.forEach((s, i) => {
      const w = (s.value / total) * usable;
      if (w <= 0.5) { cursor += w + GAP; return; }
      const first = i === 0, last = i === live.length - 1;
      const g = svg('g', { style: 'cursor: default', tabindex: '0', role: 'listitem',
        'aria-label': `${s.label} ${fmt.bytes(s.value)}，占 ${((s.value / total) * 100).toFixed(1)}%` });

      g.append(svg('path', {
        d: roundedRect(cursor, 0, w, height, first ? RADIUS : 0, last ? RADIUS : 0),
        fill: s.color,
      }));

      // 只有真的放得下（左右各留 8px）才把百分比寫進色塊，否則交給圖例與提示。
      const pctText = `${((s.value / total) * 100).toFixed(0)}%`;
      if (w > textWidth(pctText, '600 11px system-ui') + 16) {
        g.append(svg('text', {
          x: cursor + w / 2, y: height / 2 + 4, 'text-anchor': 'middle',
          style: `font-size: 11px; font-weight: 600; fill: ${s.onFill ?? '#fff'}`,
        }, [txt(pctText)]));
      }

      const show = () => {
        tip.replaceChildren(
          el('div', { class: 'tt-title', text: s.label }),
          el('div', { class: 'tt-row' }, [
            el('span', { class: 'tt-key', style: `background: ${s.color}` }),
            el('span', { class: 'tt-name', text: `占 ${((s.value / total) * 100).toFixed(1)}%` }),
            el('span', { class: 'tt-val', text: fmt.bytes(s.value) }),
          ]),
        );
        tip.dataset.show = 'true';
        const tw = tip.offsetWidth || 150;
        tip.style.left = `${Math.max(0, Math.min(W - tw, cursor + w / 2 - tw / 2))}px`;
        tip.style.top = `${-tip.offsetHeight - 6}px`;
      };
      g.addEventListener('pointerenter', show);
      g.addEventListener('focus', show);
      g.addEventListener('pointerleave', () => { tip.dataset.show = 'false'; });
      g.addEventListener('blur', () => { tip.dataset.show = 'false'; });

      root.append(g);
      cursor += w + GAP;
    });

    container.append(root);
  }, [tip]);

  return container;
}

// ==========================================================================
// 排行橫條（單一序列 → 單一顏色，絕不依大小上色階）
// ==========================================================================

/**
 * @param {Array<{label:string, value:number, href?:string, note?:string}>} items
 */
export function barList(items, { max = 12, color = 'var(--series-1)', labelWidth = 150 } = {}) {
  const container = el('div', { class: 'chart' });
  const tip = el('div', { class: 'tooltip' });
  container.append(tip);

  responsive(container, (W) => {
    const rows = items.slice(0, max).filter((r) => r.value > 0);
    if (!rows.length) { container.append(emptyState('沒有資料')); return; }

    const rowH = 26, barH = Math.min(14, rowH - 12);
    const lw = Math.min(labelWidth, Math.max(90, W * 0.32));
    const valueW = 74;
    const plotW = Math.max(40, W - lw - valueW - 12);
    const maxV = Math.max(...rows.map((r) => r.value));
    const H = rows.length * rowH;

    const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': '各 repository 佔用空間排行' });

    rows.forEach((r, i) => {
      const cy = i * rowH + rowH / 2;
      const w = Math.max(2, (r.value / maxV) * plotW);

      // 名稱過長就截斷加省略號 —— 量測後才截，不靠 CSS 裁切。
      let label = r.label;
      while (textWidth(label, '13px system-ui') > lw - 8 && label.length > 4) label = label.slice(0, -2);
      if (label !== r.label) label += '…';

      const g = svg('g', { tabindex: '0', role: 'listitem',
        'aria-label': `${r.label}：${fmt.bytes(r.value)}` });

      g.append(svg('text', {
        x: 0, y: cy + 4, class: 'axis-label',
        style: 'font-size: 12.5px; fill: var(--text-secondary)',
      }, [txt(label)]));

      // 4px 圓角資料端，基線側維持方角。
      g.append(svg('path', { d: roundedRect(lw, cy - barH / 2, w, barH, 0, RADIUS), fill: color }));

      // 值標在條的尖端 —— 這是規範要求的直接標籤，也是淺色模式的對比補償。
      g.append(svg('text', {
        x: lw + w + 8, y: cy + 4, class: 'axis-label',
        style: 'font-size: 12px; fill: var(--text-primary); font-weight: 600',
      }, [txt(fmt.bytes(r.value))]));

      const show = () => {
        tip.replaceChildren(
          el('div', { class: 'tt-title', text: r.label }),
          el('div', { class: 'tt-row' }, [
            el('span', { class: 'tt-key', style: `background: ${color}` }),
            el('span', { class: 'tt-name', text: r.note ?? '佔用空間' }),
            el('span', { class: 'tt-val', text: fmt.bytes(r.value) }),
          ]),
        );
        tip.dataset.show = 'true';
        const tw = tip.offsetWidth || 150;
        tip.style.left = `${Math.max(0, Math.min(W - tw, lw + w / 2 - tw / 2))}px`;
        tip.style.top = `${Math.max(0, cy - tip.offsetHeight - 8)}px`;
      };
      g.addEventListener('pointerenter', show);
      g.addEventListener('focus', show);
      g.addEventListener('pointerleave', () => { tip.dataset.show = 'false'; });
      g.addEventListener('blur', () => { tip.dataset.show = 'false'; });

      if (r.href) {
        const a = svg('a', { href: r.href, target: '_blank', rel: 'noopener' });
        a.append(g);
        root.append(a);
      } else root.append(g);
    });

    // 基線：一條 hairline 實線。
    root.append(svg('line', { x1: lw, x2: lw, y1: 0, y2: H, class: 'axisline' }));
    container.append(root);
  }, [tip]);

  return container;
}

// ==========================================================================
// 儀表（單一比例對上限）
// ==========================================================================

export function meter(q) {
  const pct = q.percent;
  const capped = pct == null ? 0 : Math.min(100, pct);
  const fillColor = {
    good: 'var(--seq-450)', warning: 'var(--warning)',
    serious: 'var(--serious)', critical: 'var(--critical)',
  }[q.severity] ?? 'var(--seq-450)';
  // 軌道用填色的淡版，狀態才會讀得過整條 bar，而不是只有填滿的那一段。
  const trackColor = `color-mix(in srgb, ${fillColor} 20%, var(--surface-2))`;

  const unavailable = q.available === false || pct == null;

  return el('div', { class: `meter${unavailable ? ' unavailable' : ''}` }, [
    el('div', { class: 'meter-head' }, [
      el('span', { class: 'meter-label', text: q.label }),
      el('span', { class: 'spacer' }),
      unavailable
        ? el('span', { class: 'badge neutral', text: '需要權杖' })
        : statusBadge(q.severity, `${pct.toFixed(pct < 10 ? 1 : 0)}%`),
    ]),
    el('div', {
      class: 'meter-track',
      style: unavailable ? null : `background: ${trackColor}`,
      role: 'meter',
      'aria-valuenow': unavailable ? '0' : capped.toFixed(1),
      'aria-valuemin': '0', 'aria-valuemax': '100',
      'aria-label': `${q.label}：${unavailable ? '無資料' : `已用 ${pct.toFixed(1)}%`}`,
    }, [
      unavailable ? null : el('div', { class: 'meter-fill', style: `width: ${capped}%; background: ${fillColor}` }),
    ]),
    el('div', { class: 'meter-foot' }, [
      el('span', {
        text: unavailable
          ? (q.note ?? '無資料')
          : `${q.unit === 'minutes' ? fmt.num(q.used) + ' 分鐘' : fmt.bytes(q.used)} / ${q.unit === 'minutes' ? fmt.num(q.limit) + ' 分鐘' : fmt.bytes(q.limit)}${q.estimated ? '（估算）' : ''}`,
      }),
    ]),
  ]);
}

/** 狀態一律「圖示 + 文字 + 顏色」三重編碼，顏色從不單獨表意。 */
export function statusBadge(severity, text) {
  const icons = {
    good: 'M13.5 4.5 6 12 2.5 8.5',
    warning: 'M8 5v4M8 11.5v.5',
    serious: 'M8 5v4M8 11.5v.5',
    critical: 'M8 5v4M8 11.5v.5',
  };
  const labels = { good: '正常', warning: '注意', serious: '偏高', critical: '危險' };
  const icon = svg('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' }, [
    severity === 'good'
      ? svg('path', { d: icons.good, stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
      : svg('g', {}, [
          svg('path', { d: 'M8 1.8 15 14H1z', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linejoin': 'round', fill: 'none' }),
          svg('path', { d: icons[severity], stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' }),
        ]),
  ]);
  return el('span', { class: `badge ${severity}`, title: labels[severity] }, [icon, txtNode(text)]);
}

// ==========================================================================
// 共用零件
// ==========================================================================

export function emptyState(message, hint = null) {
  return el('div', { class: 'empty' }, [
    svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }, [
      svg('path', { d: 'M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7M3 7l2.5-3h13L21 7M3 7h18M9 12h6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    ]),
    el('strong', { text: message }),
    hint ? el('span', { text: hint }) : null,
  ]);
}

/**
 * 每張圖的表格孿生體。這不是可選項：淺色模式有三個色階低於 3:1 對比，
 * 規範要求必須提供表格或可見標籤作為補償。
 */
export function dataTable(columns, rows, { sortable = false, cap = false } = {}) {
  const table = el('table', { class: 'data' });
  let sortKey = null, sortDir = -1;

  const thead = el('thead');
  const headRow = el('tr');
  columns.forEach((c) => {
    const th = el('th', {
      class: [c.numeric ? 'num' : '', sortable && c.key ? 'sortable' : ''].filter(Boolean).join(' '),
      'aria-sort': 'none',
      scope: 'col',
      text: c.label,
    });
    if (sortable && c.key) {
      th.tabIndex = 0;
      const doSort = () => {
        sortDir = sortKey === c.key ? -sortDir : -1;
        sortKey = c.key;
        headRow.querySelectorAll('th').forEach((n) => n.setAttribute('aria-sort', 'none'));
        th.setAttribute('aria-sort', sortDir === -1 ? 'descending' : 'ascending');
        render();
      };
      th.addEventListener('click', doSort);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doSort(); } });
    }
    headRow.append(th);
  });
  thead.append(headRow);

  const tbody = el('tbody');
  const render = () => {
    const sorted = sortKey
      ? [...rows].sort((a, b) => {
          const av = a[sortKey], bv = b[sortKey];
          if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * -sortDir;
          return String(av ?? '').localeCompare(String(bv ?? ''), 'zh-TW') * -sortDir;
        })
      : rows;
    tbody.replaceChildren(...sorted.map((r) => {
      const tr = el('tr');
      columns.forEach((c) => {
        const cell = c.render ? c.render(r) : String(r[c.key] ?? '—');
        tr.append(el('td', { class: c.numeric ? 'num' : (c.cls ?? '') },
          typeof cell === 'string' ? [txtNode(cell)] : [cell]));
      });
      return tr;
    }));
  };
  render();

  table.append(thead, tbody);
  const wrap = el('div', { class: `table-wrap${cap ? ' scroll-cap' : ''}` }, [table]);
  return wrap;
}

/** 把圖表與表格包成同一張卡的兩個檢視，右上角切換。 */
export function chartCard({ title, subtitle, chart, table, span = 'col-6', extra = null }) {
  const chartWrap = el('div', {}, [chart]);
  const tableWrap = el('div', { style: 'display: none' }, table ? [table] : []);

  const head = el('div', { class: 'card-head' }, [
    el('h2', { class: 'card-title', text: title }),
    el('span', { class: 'spacer' }),
    extra,
  ]);

  if (table) {
    const btnChart = el('button', { type: 'button', text: '圖表', 'aria-pressed': 'true' });
    const btnTable = el('button', { type: 'button', text: '表格', 'aria-pressed': 'false' });
    const set = (showTable) => {
      chartWrap.style.display = showTable ? 'none' : '';
      tableWrap.style.display = showTable ? '' : 'none';
      btnChart.setAttribute('aria-pressed', String(!showTable));
      btnTable.setAttribute('aria-pressed', String(showTable));
    };
    btnChart.addEventListener('click', () => set(false));
    btnTable.addEventListener('click', () => set(true));
    head.append(el('div', { class: 'viewtoggle', role: 'group', 'aria-label': `${title} 檢視方式` }, [btnChart, btnTable]));
  }

  return el('section', { class: `card ${span}` }, [
    head,
    subtitle ? el('p', { class: 'card-sub', text: subtitle }) : el('div', { style: 'height: 12px' }),
    chartWrap,
    tableWrap,
  ]);
}

// ---------------------------------------------------------------- 小工具

/** 只在指定角落加圓角的矩形路徑。 */
function roundedRect(x, y, w, h, rLeft, rRight) {
  const rl = Math.min(rLeft, w / 2, h / 2);
  const rr = Math.min(rRight, w / 2, h / 2);
  return [
    `M${x + rl},${y}`,
    `H${x + w - rr}`,
    rr ? `A${rr},${rr} 0 0 1 ${x + w},${y + rr}` : '',
    `V${y + h - rr}`,
    rr ? `A${rr},${rr} 0 0 1 ${x + w - rr},${y + h}` : '',
    `H${x + rl}`,
    rl ? `A${rl},${rl} 0 0 1 ${x},${y + h - rl}` : '',
    `V${y + rl}`,
    rl ? `A${rl},${rl} 0 0 1 ${x + rl},${y}` : '',
    'Z',
  ].filter(Boolean).join(' ');
}

const txt = (s) => document.createTextNode(String(s));
const txtNode = txt;
export { txt };
