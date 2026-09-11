'use strict';

// Loads the scan output and renders it. There is no login: the published build
// carries only market data and scores, and the local build never leaves this PC.
// Locally the server has site.local.json (with your portfolio); the published
// site only has site.json. Try the local one first and fall back.
const DATA_URLS = ['data/site.local.json', 'data/site.json'];
const GH_KEY = 'watchlist-gh';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtWhen = (d) => new Date(d).toLocaleString('en-GB',
  { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The scan times from .github/workflows/daily-scan.yml, in UTC minutes past
 * midnight. GitHub cron is always UTC, so these are fixed points that shift
 * by an hour in UK terms when the clocks change — exactly as the runs do.
 */
const SCAN_SLOTS_UTC = [
  5 * 60,                                             // 05:00 overnight
  ...Array.from({ length: 12 }, (_, i) => 13 * 60 + 30 + i * 30), // 13:30 to 19:00
];

/** Next scheduled scan after `from`, skipping weekends. Returns a Date. */
function nextScanAfter(from = new Date()) {
  for (let dayOffset = 0; dayOffset < 5; dayOffset++) {
    const day = new Date(from);
    day.setUTCDate(day.getUTCDate() + dayOffset);
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue; // no runs at weekends

    for (const slot of SCAN_SLOTS_UTC) {
      const candidate = new Date(Date.UTC(
        day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(),
        Math.floor(slot / 60), slot % 60, 0, 0
      ));
      if (candidate > from) return candidate;
    }
  }
  return null;
}

/**
 * Whether the US market is open, and if not, when it next opens. Prices only
 * move while it trades, so "prices unchanged" after a scan is expected outside
 * those hours — and saying so is far more use than stating the fact alone.
 */
function usMarketState(now = new Date()) {
  // Read the London parts directly. Round-tripping through toLocaleString and
  // back into new Date() misparses "12/09/2026" as 9 December, which silently
  // breaks the weekday check.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const OPEN = 14 * 60 + 30;   // 14:30 UK
  const CLOSE = 21 * 60;       // 21:00 UK

  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') {
    return { open: false, reason: 'markets are closed at the weekend' };
  }
  if (mins < OPEN) return { open: false, reason: 'US markets open at 14:30 UK' };
  if (mins >= CLOSE) return { open: false, reason: 'US markets closed at 21:00 UK' };
  return { open: true, reason: null };
}

/** "in 12 minutes", "in 2 hours" — a sense of how fresh the next one is. */
function untilText(date) {
  const mins = Math.round((date - Date.now()) / 60000);
  if (mins <= 1) return 'any moment';
  if (mins < 60) return `in ${mins} minutes`;
  const hrs = Math.round(mins / 60);
  return `in about ${hrs} hour${hrs === 1 ? '' : 's'}`;
}

let current = null; // last loaded payload, so Refresh can compare

/** Local build first, published build as the fallback. */
async function fetchPayload() {
  let lastStatus = 0;
  for (const url of DATA_URLS) {
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) return res.json();
    lastStatus = res.status;
  }
  throw new Error(`Could not load data (HTTP ${lastStatus})`);
}

/* ---------- rendering ---------- */

function sparkline(values) {
  if (!values || values.length < 2) return '';
  const w = 300, h = 40, pad = 2;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const colour = values[values.length - 1] >= values[0] ? 'var(--good)' : 'var(--bad)';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts.join(' ')}" fill="none" stroke="${colour}" stroke-width="1.8"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/**
 * Entry levels. Deliberately framed as levels the rules flag, with the arithmetic
 * shown, rather than as a recommendation to buy at a price.
 */
/**
 * What you actually get depending on where in the zone you buy. The spread
 * between bottom and top is usually two to three times the reward per unit of
 * risk, which makes this the most consequential number on the card.
 */
/**
 * Work out the trade for one entry price. The hit rate is interpolated from
 * backtests actually run at five points across the zone, so a lower entry
 * reports a genuinely higher measured win rate rather than an assumed one.
 */
function tradeAt(price, entry, curve) {
  const span = entry.high - entry.low;
  const position = span > 0 ? Math.max(0, Math.min(1, (price - entry.low) / span)) : 0;

  // The fitted trend, not the raw backtest points. Each point rests on only a
  // few dozen trades, so reading them straight off made this jump around as you
  // dragged the slider — movement that was sampling noise, not evidence.
  const hitRate = curve?.fit
    ? Math.max(0.02, Math.min(0.98, curve.fit.intercept + curve.fit.slope * position))
    : null;
  const risk = price - entry.stopLoss;
  const exit = price + risk * 2;
  const gainPct = (risk * 2 / price) * 100;
  const lossPct = (risk / price) * 100;

  return {
    position, hitRate, exit,
    stop: entry.stopLoss,
    gainPct, lossPct,
    // The average outcome per trade: how often it works, times what it pays,
    // minus how often it fails, times what that costs.
    expectancy: hitRate == null ? null : hitRate * gainPct - (1 - hitRate) * lossPct,
    needsNewHigh: exit > entry.recentHigh,
    outsideZone: price < entry.low || price > entry.high,
  };
}

/**
 * A single 0-10 read on how well one entry price stacks up against our rules.
 *
 * It starts from the average outcome at that price, after allowing for what
 * dealing actually costs, then docks points for the things that spoil a setup.
 * It is a summary of the same evidence shown below it, not a separate opinion,
 * and certainly not a probability of making money.
 */
const DEALING_COST_PCT = 0.8; // spread plus FX on a dollar stock, roughly

function worthScore(t, s) {
  if (t.expectancy == null) return null;

  const met = (fragment) => s.checklist?.items.find((i) => i.label.includes(fragment))?.met;
  const holdingBack = [];
  let score = 5 + (t.expectancy - DEALING_COST_PCT) * 0.85;

  if (t.outsideZone)  { score -= 2.5; holdingBack.push('the price is outside the entry zone'); }
  if (t.needsNewHigh) { score -= 1.2; holdingBack.push('the target needs a fresh 20-day high'); }
  if (met('earnings') === false) { score -= 1.0; holdingBack.push('earnings are due within days'); }
  if (met('trend') === false)    { score -= 0.8; holdingBack.push('the medium-term trend is not up'); }
  if (s.risk?.level === 'High')  { score -= 0.6; holdingBack.push('this is a high-risk stock'); }
  score += (s.score - 6) * 0.25; // the stock's own score, gently

  // Thin evidence should not produce confident-looking extremes, so pull the
  // result back toward the middle when there are few past trades behind it.
  if ((s.entryCurve?.trades?.min ?? 99) < 15) score = 5 + (score - 5) * 0.85;

  score = Math.max(0, Math.min(10, score));
  const verdict =
    score >= 8.5 ? 'About as well as a setup on this list ever scores'
    : score >= 7  ? 'Stacks up well against our rules'
    : score >= 5.5 ? 'Reasonable, without being one of the better ones'
    : score >= 4  ? 'Marginal &mdash; the odds barely cover the dealing costs'
    : score >= 2.5 ? 'Weak against our rules'
    : 'Our rules do not support this price';

  return { score, verdict, holdingBack, tone: score >= 7 ? 'good' : score >= 4.5 ? 'mid' : 'bad' };
}

/** The worth-it block: the headline number, a bar, and what is dragging it down. */
function worthHtml(w) {
  if (!w) return '';
  return `<div class="worth w-${w.tone}">
    <div class="worth-top">
      <span class="worth-label">Worth it?</span>
      <span class="worth-num">${w.score.toFixed(1)}<small>/10</small></span>
    </div>
    <div class="worth-bar"><i style="width:${w.score * 10}%"></i></div>
    <div class="worth-say">${w.verdict}.${w.holdingBack.length
      ? ` Held back because ${w.holdingBack.join(', and ')}.`
      : ''}</div>
  </div>`;
}
/** The per-card calculator. Rendered once; the numbers update as you type. */
function calculatorHtml(s) {
  const e = s.entry;
  if (!e || e.status === 'none' || !s.entryCurve) return '';

  // Start at what the stock actually costs right now, so the card opens on the
  // question you are really asking. The slider stretches to cover today's price
  // when that sits outside the zone, which is most of the "wait" setups.
  const lo = Math.min(e.low, s.price);
  const hi = Math.max(e.high, s.price);
  const start = Number(s.price.toFixed(2));
  const step = hi - lo > 20 ? 1 : hi - lo > 2 ? 0.1 : 0.01;

  return `<div class="calc" data-ticker="${esc(s.ticker)}">
    <div class="calc-head">Try a price</div>
    <p class="calc-hint">Starts at today&rsquo;s price of $${start}. Type another, or drag
       the slider, to see what a different entry would mean. The entry zone is
       $${e.low} &ndash; $${e.high}.</p>
    <div class="calc-input">
      <span class="calc-currency">$</span>
      <input type="number" class="calc-price" value="${start}"
             min="${lo}" max="${hi}" step="${step}"
             inputmode="decimal" aria-label="Entry price for ${esc(s.ticker)}">
      <input type="range" class="calc-slider"
             min="${lo}" max="${hi}" step="any" value="${start}"
             aria-label="Entry price slider for ${esc(s.ticker)}">
    </div>
    <div class="calc-out"></div>
  </div>`;
}
/** Fill in one calculator's output for the price currently entered. */
function renderCalc(box, s) {
  const price = Number(box.querySelector('.calc-price').value);
  const out = box.querySelector('.calc-out');
  if (!Number.isFinite(price) || price <= 0) { out.innerHTML = ''; return; }

  const t = tradeAt(price, s.entry, s.entryCurve);
  const pct = t.hitRate == null ? null : Math.round(t.hitRate * 100);
  const tone = t.expectancy == null ? '' : t.expectancy > 1 ? 'in' : t.expectancy > 0 ? 'wait' : 'hot';

  out.innerHTML = `
    ${worthHtml(worthScore(t, s))}
    <div class="calc-grid">
      <div><span>Stop loss</span><strong class="bad-t">$${t.stop.toFixed(2)}</strong></div>
      <div><span>Exit target</span><strong class="good-t">$${t.exit.toFixed(2)}</strong></div>
      <div><span>You risk</span><strong class="bad-t">&minus;${t.lossPct.toFixed(1)}%</strong></div>
      <div><span>You gain</span><strong class="good-t">+${t.gainPct.toFixed(1)}%</strong></div>
    </div>
    <div class="calc-verdict ${tone}">
      ${pct == null
        ? 'Not enough past setups at this price to measure a hit rate.'
        : `<strong>${pct}%</strong> of past setups bought here reached the target before the stop`}
      ${pct == null || !s.entryCurve?.trades ? '' :
        `<div class="calc-ev">Measured on ${s.entryCurve.trades.min}&ndash;${s.entryCurve.trades.max} past setups on ${esc(s.ticker)}, which is thin evidence &mdash; treat it as a rough steer.</div>`}
      ${t.expectancy == null ? '' :
        `<div class="calc-ev">Wins and losses together, that averages <strong class="${t.expectancy >= 0 ? 'good-t' : 'bad-t'}">${
          t.expectancy >= 0 ? '+' : ''}${t.expectancy.toFixed(1)}%</strong> of your money per trade</div>`}
    </div>
    ${t.outsideZone ? '<p class="entry-note bad-t">That price is outside the entry zone, so the measured hit rate does not cover it.</p>' : ''}
    ${t.needsNewHigh ? `<p class="entry-note">This target is above the recent 20-day high of $${s.entry.recentHigh}, so it needs a fresh high rather than a return to a level already reached.</p>` : ''}
  `;
}

/** The wordy part of the entry block, split out so a card can collapse it. */
function entryNotesHtml(e) {
  if (!e || e.status === 'none') return '';
  return `<p class="entry-note"><strong>Stop loss</strong> is the level below which the
      setup described above is no longer true. It sits under the recent low and more than
      a typical day&rsquo;s move below the zone, so ordinary wobble should not reach it.
      The &minus;${e.riskPct}% assumes buying inside the zone; from today&rsquo;s price the
      stop is <strong>${e.stopFromTodayPct}%</strong> away.</p>
    <p class="entry-note">${esc(e.note)} These are calculated from past prices, not a forecast.</p>`;
}

function entryHtml(e, { withNotes = true } = {}) {
  if (!e) return '';
  if (e.status === 'none') {
    return `<div class="entry none">
      <div class="entry-head">Entry levels</div>
      <p class="entry-note">${esc(e.note)}</p>
    </div>`;
  }
  const state = e.status === 'in-zone'
    ? '<span class="pill in">Price is in the zone now</span>'
    : `<span class="pill wait">Would need to fall ${e.fallToZonePct}% to reach it</span>`;

  return `<div class="entry">
    <div class="entry-head">Entry levels ${state}</div>
    <div class="entry-grid">
      <div><span>Entry zone</span><strong>$${e.low} &ndash; $${e.high}</strong></div>
      <div><span>Exit target</span><strong class="good-t">$${e.exit}</strong></div>
      <div><span>Stop loss</span><strong class="bad-t">$${e.stopLoss}</strong></div>
      <div><span>Reward vs risk</span><strong>${e.rewardRisk == null ? '—'
        : `${e.rewardRisk} : 1`}</strong></div>
      <div><span>Gain if it reaches the exit</span><strong class="good-t">+${e.rewardPct}%</strong></div>
      <div><span>Loss if the stop is hit</span><strong class="bad-t">&minus;${e.riskPct}%</strong></div>
    </div>

    ${withNotes ? entryNotesHtml(e) : ''}
  </div>`;
}

function headlineHtml(h) {
  const when = h.published
    ? new Date(h.published).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';
  const tag = h.catalyst ? `<span class="tag">${esc(h.catalyst)}</span>` : '';
  return `<a class="headline" href="${esc(h.link)}" target="_blank" rel="noopener noreferrer">
    <span class="h-meta"><span class="dot ${esc(h.label)}"></span>${tag}</span>
    <span class="h-title">${esc(h.title)}</span>
    <span class="tag" style="margin-left:5px">${esc(h.publisher)}${when ? ' &middot; ' + esc(when) : ''}</span>
  </a>`;
}

// Plain-English names for the scoring components, rather than the raw keys.
const LABELS = {
  rsi: 'Momentum gauge', trend: 'Trend', volume: 'Volume', momentum: 'Recent moves',
  news: 'News', earningsGrowth: 'Profit growth', revenueGrowth: 'Sales growth', valuation: 'Valuation',
};

function breakdownHtml(breakdown) {
  const rows = Object.entries(breakdown).map(([key, v]) => `<div class="bar-row">
      <div class="bar-top"><span>${esc(LABELS[key] ?? key)} &middot; ${v.weight}% of score</span><span>${v.score}/10</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${v.score * 10}%"></div></div>
      <div class="bar-note">${esc(v.note)}</div>
    </div>`).join('');
  return `<details><summary>Why this score</summary><div class="bars">${rows}</div></details>`;
}

const RISK_CLASS = { 'Low': 'in', 'Medium': 'wait', 'High': 'hot', 'Very high': 'hot' };

const riskPill = (risk) =>
  `<span class="pill ${RISK_CLASS[risk.level] ?? 'wait'}">${esc(risk.level)} risk</span>`;

/**
 * Measured history of this setup on this stock. Explicitly a record of what
 * happened before, never a probability that the next one works.
 */
function backtestHtml(b) {
  if (!b || b.hitRate == null) return '';
  const pct = Math.round(b.hitRate * 100);
  const ev = b.expectancyPct;
  const evClass = ev == null ? '' : ev >= 0 ? 'good-t' : 'bad-t';

  return `<div class="entry">
    <div class="entry-head">How this setup has done before
      <span class="pill ${pct >= 50 ? 'in' : 'wait'}">${pct}% reached the target first</span>
    </div>
    <div class="entry-grid">
      <div><span>Times this setup fired</span><strong>${b.occurrences} in 2 years</strong></div>
      <div><span>Reached target / stopped out</span><strong>${b.wins} / ${b.losses}</strong></div>
      <div><span>Average outcome per setup</span><strong class="${evClass}">${
        ev == null ? '—' : (ev >= 0 ? '+' : '') + ev + '%'}</strong></div>
      <div><span>Typical time held</span><strong>${b.avgBarsHeld ?? '—'} days</strong></div>
    </div>
    <p class="entry-note">
      ${b.unresolved ? `${b.unresolved} more setups hit neither level within 30 days and are excluded. ` : ''}
      <strong>Average outcome</strong> combines the hit rate with today&rsquo;s reward and
      risk, so a ${pct}% hit rate can still come out positive when the winners are bigger
      than the losers. ${!b.reliable ? '<strong>Small sample, treat with caution.</strong> ' : ''}
      This is what happened on past setups. It is not a probability that the next one works,
      and nothing here is guaranteed.
    </p>
  </div>`;
}

/**
 * Analyst consensus, shown with its spread and a check against the stock's own
 * history. The spread matters as much as the midpoint: a "target" spanning half
 * the share price is disagreement, not a forecast.
 */
function analystHtml(a) {
  if (!a) return '';
  const up = a.upsidePct >= 0;
  const horizonText = a.typicalHorizon
    ? `On its own past form, this stock has cleared ${up ? '+' : ''}${a.upsidePct}% within <strong>${a.typicalHorizon}</strong> more often than not.`
    : `On its own past form, this stock has <strong>not typically gained ${a.upsidePct}% even over 12 months</strong>, so the target implies a faster move than its own history supports.`;

  const rows = a.horizons.map((h) =>
    `<div class="check ${h.hitRate >= 50 ? 'yes' : 'no'}"><span>${h.hitRate >= 50 ? '✓' : '✗'}</span>
      Over ${h.label}: reached this upside in ${h.hitRate}% of past periods (median move ${h.medianReturn >= 0 ? '+' : ''}${h.medianReturn}%)</div>`
  ).join('');

  // A target the stock has never historically reached should not be shown in
  // "good" green: that reads as endorsement rather than as someone's forecast.
  const pillClass = !up ? 'hot' : a.typicalHorizon ? 'in' : 'wait';

  return `<div class="entry">
    <div class="entry-head">Analyst target &middot; 12 months
      <span class="pill ${pillClass}">Analysts predict ${up ? '+' : ''}${a.upsidePct}%</span>
      ${!a.typicalHorizon ? '<span class="pill hot">Beyond its own history</span>' : ''}
    </div>
    <div class="entry-grid">
      <div><span>Average target</span><strong class="${up ? 'good-t' : 'bad-t'}">$${a.mean}</strong></div>
      <div><span>Range across analysts</span><strong>$${a.low} &ndash; $${a.high}</strong></div>
      <div><span>Analysts covering</span><strong>${a.count ?? '—'}</strong></div>
      <div><span>Consensus view</span><strong style="text-transform:capitalize">${esc(a.recommendation ?? '—')}</strong></div>
    </div>
    <details><summary>How long a move like that has taken before</summary>
      <div class="checks">${rows}</div>
    </details>
    <p class="entry-note">${horizonText}
      ${a.spreadPct >= 40 ? `<strong>The analysts disagree sharply</strong> — the highest target is ${a.spreadPct}% above the lowest, so the average is a midpoint of wide disagreement rather than a consensus. ` : ''}
      Price targets are a 12-month convention, are frequently wrong, and are not a forecast of what will happen.</p>
  </div>`;
}

/**
 * One-line track record, shown on the collapsed card. This is the closest
 * honest answer to "how likely is this to work", so it should not be hidden
 * behind a toggle — but it is a measured past hit rate, never a prediction.
 */
function trackRecordHtml(b) {
  if (!b || b.hitRate == null) return '';
  const pct = Math.round(b.hitRate * 100);
  const ev = b.expectancyPct;
  const tone = ev == null ? 'wait' : ev > 1 ? 'in' : ev > 0 ? 'wait' : 'hot';

  const verdict = ev == null ? 'no current setup to price'
    : ev > 1 ? 'made money on average'
    : ev > 0 ? 'about broke even'
    : 'lost money on average';

  return `<div class="track ${tone}">
    <div class="track-main">
      <strong>${pct}%</strong> of the last ${b.wins + b.losses} setups reached the target
      before the stop${ev == null ? '' : `, and ${esc(verdict)}`}
    </div>
    <div class="track-sub">
      ${ev == null ? '' : `<span class="${ev >= 0 ? 'good-t' : 'bad-t'}">${ev >= 0 ? '+' : ''}${ev}% average per setup</span> · `}
      ${b.occurrences} in 2 years · typically held ${b.avgBarsHeld} days
      ${!b.reliable ? ' · <strong>small sample</strong>' : ''}
    </div>
  </div>`;
}

/** Which of our criteria this stock meets, shown as plain ticks and crosses. */
function checklistHtml(c) {
  if (!c) return '';
  const rows = c.items.map((i) =>
    `<div class="check ${i.met ? 'yes' : 'no'}"><span>${i.met ? '✓' : '✗'}</span>${esc(i.label)}</div>`
  ).join('');
  return `<details${c.all ? ' open' : ''}>
    <summary>Meets ${c.met} of ${c.total} criteria</summary>
    <div class="checks">${rows}</div>
  </details>`;
}

/**
 * Stocks meeting every criterion today. Deliberately a filter, not a
 * recommendation: it says what matched, and nothing about what will happen.
 */
function shortlistHtml(swing) {
  const all = byWorthNow(swing.filter((s) => s.checklist?.all));
  const near = swing.filter((s) => s.checklist && !s.checklist.all)
    .sort((a, b) => b.checklist.met - a.checklist.met).slice(0, 3);

  const body = all.length
    ? all.map((s) => `<div class="short-row">
        <strong>${esc(s.ticker)}</strong>
        <span>${worthNow(s) == null ? '&mdash;' : worthNow(s).toFixed(1) + '/10 at today&rsquo;s price'}
          &middot; ${esc(s.risk.level.toLowerCase())} risk &middot; ${s.entry.rewardRisk}:1 reward vs risk</span>
      </div>`).join('')
    : `<p class="entry-note" style="margin-top:0">Nothing meets all six today. Closest:
        ${near.map((s) => `${esc(s.ticker)} (${s.checklist.met}/6)`).join(', ')}.</p>`;

  return `<div class="entry" style="margin-top:0">
    <div class="entry-head">Matches every criterion
      <span class="pill ${all.length ? 'in' : 'wait'}">${all.length} of ${swing.length}</span>
    </div>
    ${body}
    <p class="entry-note">These met all six checks in the scan. That is a filter for
      what to look at first, not a recommendation, and it says nothing about what any
      of them will do next.</p>
  </div>`;
}

function cardHtml(s, { collapsible = false } = {}) {
  const tier = s.score >= 7 ? 'high' : s.score >= 5 ? 'mid' : 'low';
  const dir = s.changePct >= 0 ? 'up' : 'down';
  const sign = s.changePct >= 0 ? '+' : '';
  const warnings = s.warnings.length
    ? `<div class="warn">${s.warnings.map((w) => `<div>${esc(w)}</div>`).join('')}</div>` : '';
  const news = s.headlines.length
    ? s.headlines.map(headlineHtml).join('')
    : '<p class="no-news">No company-specific headlines in the last 48 hours.</p>';

  return `<article class="card">
    <div class="row">
      <div class="badge ${tier}">${s.score}</div>
      <div class="ident">
        <div class="ticker">${esc(s.ticker)}${s.held
          ? ` <span class="pill ${(s.held.pplPct ?? 0) >= 0 ? 'in' : 'wait'}">You hold ${fmtQty(s.held.quantity)}${
              s.held.pplPct == null ? '' : ` &middot; ${s.held.pplPct >= 0 ? '+' : ''}${s.held.pplPct}%`}</span>`
          : ''}</div>
        <div class="company">${esc(s.name)} ${riskPill(s.risk)}</div>
      </div>
      <div class="px">
        <div class="px-val">$${s.price.toFixed(2)}</div>
        <div class="px-chg ${dir}">${sign}${s.changePct.toFixed(2)}%</div>
      </div>
    </div>
    ${sparkline(s.sparkline)}
    <p class="reason">${esc(s.reason)}</p>
    ${warnings}
    ${entryHtml(s.entry, { withNotes: !collapsible })}
    ${calculatorHtml(s)}
    ${collapsible ? trackRecordHtml(s.backtest) : ''}
    ${collapsible
      // Collapsed, a card shows only what you need to judge it at a glance:
      // score, price, why, and the levels. Everything else is one tap away.
      ? `<details class="more">
          <summary><span class="more-open">Show detail</span><span class="more-shut">Hide detail</span></summary>
          <div class="more-body">
            ${entryNotesHtml(s.entry)}
            ${analystHtml(s.analysts)}
            ${backtestHtml(s.backtest)}
            ${checklistHtml(s.checklist)}
            ${breakdownHtml(s.breakdown)}
            <div class="news">${news}</div>
          </div>
        </details>`
      : `${analystHtml(s.analysts)}
         ${backtestHtml(s.backtest)}
         ${checklistHtml(s.checklist)}
         ${breakdownHtml(s.breakdown)}
         <div class="news">${news}</div>`}
  </article>`;
}

const money = (v, ccy) => v == null ? '—'
  : new Intl.NumberFormat('en-GB', { style: 'currency', currency: ccy || 'GBP' }).format(v);
const signed = (v, ccy) => v == null ? '—' : (v >= 0 ? '+' : '−') + money(Math.abs(v), ccy);

/** A share price in its own currency, to sensible precision. */
const price = (v, ccy) => v == null ? '—'
  : new Intl.NumberFormat('en-GB', {
      style: 'currency', currency: ccy || 'USD',
      // Penny stocks need more decimals than a £100 ETF.
      minimumFractionDigits: 2, maximumFractionDigits: v < 10 ? 4 : 2,
    }).format(v);

/** Fractional shares, trimmed: 4.06097827 reads as 4.061, 200 stays 200. */
const fmtQty = (v) => v == null ? '—'
  : Number(v.toFixed(4)).toLocaleString('en-GB', { maximumFractionDigits: 4 });

const CHECK_ICON = { ok: '✓', note: '!', flag: '✗' };

/**
 * Health check results. Every line is an observation about what is held, with
 * the relevant convention named where one exists — never a recommendation.
 */
function healthHtml(h) {
  if (!h) return '';
  const { flags, notes } = h.summary;
  const verdict = flags ? `${flags} to look at` : notes ? `${notes} worth knowing` : 'Nothing flagged';

  const items = h.checks.map((c) => `<div class="hc-item ${c.status}">
      <div class="hc-top">
        <span class="hc-icon">${CHECK_ICON[c.status]}</span>
        <div>
          <div class="hc-label">${esc(c.label)}</div>
          <div class="hc-headline">${esc(c.headline)}</div>
        </div>
      </div>
      <p class="hc-detail">${esc(c.detail.replace(/\s+/g, ' '))}</p>
      ${c.rows?.length ? `<div class="hc-rows">${c.rows.map((r) =>
        `<div><span>${esc(r.label)}</span><strong>${esc(r.value)}</strong></div>`).join('')}</div>` : ''}
    </div>`).join('');

  return `<details class="entry hc" id="health">
    <summary class="entry-head" style="cursor:pointer">Portfolio health check
      <span class="pill ${flags ? 'hot' : notes ? 'wait' : 'in'}">${esc(verdict)}</span>
    </summary>
    <div class="hc-body">
      ${items}
      <p class="entry-note">Checked against what you actually hold. Where a common
        guideline exists it is named, but these are observations about the portfolio,
        not recommendations about it.</p>
    </div>
  </details>`;
}

/** Your Trading 212 holdings, cross-referenced against the watchlist. */
function portfolioHtml(p) {
  if (!p) return '<p class="no-news">Run a scan to load your portfolio.</p>';
  if (!p.available) {
    return `<div class="entry none"><div class="entry-head">Portfolio</div>
      <p class="entry-note">${esc(p.reason)}</p></div>`;
  }
  if (!p.positions.length) {
    return '<p class="no-news">Connected to Trading 212, but there are no open positions.</p>';
  }

  const ccy = p.currency;
  const c = p.cash;
  const totalPpl = p.positions.reduce((s, x) => s + (x.ppl ?? 0) + (x.fxPpl ?? 0), 0);

  const skipped = '';

  const summary = `<div class="entry">
    <div class="entry-head">Account
      <span class="pill ${totalPpl >= 0 ? 'in' : 'wait'}">${signed(totalPpl, ccy)} overall</span>
    </div>
    <div class="entry-grid">
      <div><span>Total value</span><strong>${money(c?.total, ccy)}</strong></div>
      <div><span>Invested</span><strong>${money(c?.invested, ccy)}</strong></div>
      <div><span>Available cash</span><strong>${money(c?.free, ccy)}</strong></div>
      <div><span>Positions</span><strong>${p.positions.length}</strong></div>
    </div>
    ${skipped}
    <p class="entry-note">${esc(p.accountType === 'demo' ? 'Practice account.' : 'Live account.')}
      Every figure here comes straight from Trading 212 as of the last scan.</p>
  </div>`;

  const totalValue = p.positions.reduce((s, x) => s + (x.valueAccount ?? 0), 0);

  const rows = p.positions.map((pos) => {
    const up = (pos.ppl ?? 0) >= 0;
    const share = totalValue && pos.valueAccount ? (pos.valueAccount / totalValue) * 100 : null;
    const tags = [
      pos.onWatchlist ? `<span class="tag">${esc(pos.category)} &middot; scored ${pos.score}</span>` : '',
      pos.pieQuantity ? '<span class="tag">part of a pie</span>' : '',
    ].filter(Boolean).join(' ');

    return `<article class="card pos">
      <div class="pos-top">
        <div class="pos-id">
          <div class="pos-ticker">${esc(pos.displayTicker ?? pos.ticker)}</div>
          <div class="pos-name">${esc(pos.fullName ?? pos.ticker)}</div>
        </div>
        <div class="pos-money">
          <div class="pos-value">${money(pos.valueAccount, ccy)}</div>
          <div class="pos-pl ${up ? 'up' : 'down'}">
            ${signed(pos.ppl, ccy)}${pos.pplPct == null ? '' : ` &middot; ${pos.pplPct >= 0 ? '+' : ''}${pos.pplPct}%`}
          </div>
        </div>
      </div>

      ${share != null ? `<div class="pos-bar" title="${share.toFixed(0)}% of your holdings">
        <div class="pos-bar-fill" style="width:${share.toFixed(1)}%"></div>
      </div>
      <div class="pos-share">${share.toFixed(0)}% of your holdings</div>` : ''}

      <div class="pos-facts">
        <div><span>Shares</span><strong>${fmtQty(pos.quantity)}</strong></div>
        <div><span>You paid</span><strong>${price(pos.averagePrice, pos.currency)}</strong></div>
        <div><span>Now</span><strong>${price(pos.currentPrice, pos.currency)}</strong></div>
      </div>
      ${tags ? `<div class="pos-tags">${tags}</div>` : ''}
    </article>`;
  }).join('');

  return summary + healthHtml(p.health) + rows +
    `<p class="foot">Share prices are in each holding&rsquo;s own currency; values and
      profit or loss are converted to ${esc(ccy || 'your account currency')}.</p>`;
}

/**
 * Last and next scan. The next one is only meaningful on the published build,
 * which runs to a schedule; locally scans happen when you press the button.
 */
function renderStamp(data) {
  const rows = [
    `<span class="stamp-label">Last scan</span> ${esc(fmtWhen(data.generatedAt))}` +
      (data.dataAsOf ? ` <span class="stamp-dim">· prices to ${esc(data.dataAsOf)}</span>` : ''),
  ];

  if (data.publicBuild) {
    const next = nextScanAfter();
    rows.push(next
      ? `<span class="stamp-label">Next scan</span> ${esc(fmtWhen(next))} <span class="stamp-dim">· ${esc(untilText(next))}</span>`
      : '<span class="stamp-label">Next scan</span> not scheduled');
  } else {
    rows.push('<span class="stamp-label">Next scan</span> <span class="stamp-dim">when you press Run new scan</span>');
  }

  $('stamp').innerHTML = rows.map((r) => `<div>${r}</div>`).join('');
}

/**
 * The worth-it score at today's price. This is what the swing cards are ranked
 * by: the question "what is worth buying right now" is answered by what the
 * stock costs today, not by where its zone happens to sit.
 */
function worthNow(s) {
  if (!s.entry || s.entry.status === 'none' || !s.entryCurve) return null;
  return worthScore(tradeAt(s.price, s.entry, s.entryCurve), s)?.score ?? null;
}

/** Best score first; setups with no levels to judge sit at the bottom. */
function byWorthNow(list) {
  return [...list].sort((a, b) => {
    const wa = worthNow(a), wb = worthNow(b);
    if (wa == null && wb == null) return b.score - a.score;
    if (wa == null) return 1;
    if (wb == null) return -1;
    return wb - wa;
  });
}
function render(data) {
  current = data;
  $('long-cards').innerHTML = data.longTerm.map(cardHtml).join('') || '<p class="no-news">No long-term results.</p>';
  $('swing-shortlist').innerHTML = data.swingTerm.length ? shortlistHtml(data.swingTerm) : '';
  // The badge on each card is the stock's own score against our rules, which is
  // not what the list is ordered by. Saying so stops the order looking wrong.
  const orderNote = data.swingTerm.length
    ? `<p class="order-note">Ordered by what buying at today&rsquo;s price is worth, best first.
       The number on each card is that stock&rsquo;s own score against our rules &mdash; a
       separate thing, and not what this list is sorted by.</p>`
    : '';
  $('swing-cards').innerHTML = orderNote + (byWorthNow(data.swingTerm)
    .map((x) => cardHtml(x, { collapsible: true })).join('') || '<p class="no-news">No swing-term results.</p>');
  $('portfolio-body').innerHTML = portfolioHtml(data.portfolio);
  refreshCalcs();

  renderStamp(data);

  const box = $('errors');
  if (data.errors?.length) {
    box.hidden = false;
    box.textContent = `Could not fetch: ${data.errors.map((e) => e.ticker).join(', ')}. They are missing from today's list.`;
  } else {
    box.hidden = true;
  }

  // A published build carries no portfolio and cannot run a scan, so hide the
  // controls that would only dead-end. Refresh still picks up the daily scan.
  if (data.publicBuild) {
    document.querySelector('.tab[data-target="portfolio"]')?.remove();
    $('portfolio').hidden = true;
    $('scan-btn').hidden = true;
    // The exact next time is in the header, so this only needs the cadence.
    $('scan-status').textContent = 'Updates every 30 minutes while US markets are open.';
  }

  $('app').hidden = false;
  if (!data.publicBuild) refreshT212State();
}

/* ---------- loading ---------- */

async function load() {
  try {
    render(await fetchPayload());
  } catch (e) {
    const box = $('errors');
    box.hidden = false;
    box.textContent = `${e.message} — has a scan run yet?`;
    $('app').hidden = false;
  }
}

async function refresh() {
  const btn = $('refresh');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const data = await fetchPayload();

// A page left open should not keep claiming the next scan is in 30 minutes.
setInterval(() => { if (current) renderStamp(current); }, 60000);
    if (current && data.generatedAt === current.generatedAt) {
      btn.textContent = 'No change';
    } else {
      render(data);
      btn.textContent = 'Updated';
    }
  } catch {
    btn.textContent = 'Failed';
  } finally {
    setTimeout(() => { btn.textContent = 'Refresh'; btn.disabled = false; }, 2000);
  }
}

/* ---------- running a new scan ---------- */

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const GH_KEY_STORE = () => { try { return JSON.parse(localStorage.getItem(GH_KEY)) || null; } catch { return null; } };

const status = (msg, kind = '') => {
  const el = $('scan-status');
  el.textContent = msg;
  el.className = `scan-status ${kind}`;
};

/** Guess owner/repo from a github.io URL so the setup form is mostly pre-filled. */
function guessRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (!m) return { owner: '', repo: '' };
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m[1], repo: seg || `${m[1]}.github.io` };
}

function showSetup(message = '') {
  status(message);
  const cfg = GH_KEY_STORE() ?? guessRepo();
  $('gh-owner').value = cfg.owner ?? '';
  $('gh-repo').value = cfg.repo ?? '';
  $('gh-token').value = '';
  $('gh-setup').hidden = false;
}

/** On this machine the local server runs the scanner directly — no GitHub, no token. */
async function runScanLocally() {
  const btn = $('scan-btn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  status('Fetching prices and news for every stock… about 10 seconds.');
  const previousAsOf = current?.dataAsOf;
  try {
    const res = await fetch('/api/scan', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Scan failed (HTTP ${res.status})`);

    const data = await fetchPayload();
    render(data);

    if (data.dataAsOf !== previousAsOf) {
      status(`Updated in ${body.seconds}s. Prices now to ${data.dataAsOf}.`, 'ok');
    } else {
      const market = usMarketState();
      status(`Scanned in ${body.seconds}s — news and scores refreshed. `
        + (market.open
          ? 'Prices are unchanged since the last scan.'
          : `Prices cannot change yet: ${market.reason}, so the ${data.dataAsOf} close is still the latest there is.`),
      'ok');
    }
  } catch (e) {
    status(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run new scan';
  }
}

async function triggerWorkflow(cfg) {
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/actions/workflows/daily-scan.yml/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ ref: cfg.ref || 'main' }),
  });
  if (res.status === 204) return;
  if (res.status === 401) throw new Error('Token rejected. It may have expired.');
  if (res.status === 403) throw new Error('Token lacks permission. It needs Actions: Read and write.');
  if (res.status === 404) throw new Error('Repository or workflow not found. Check the username and repo name.');
  if (res.status === 422) throw new Error('Branch not found. Your default branch may not be "main".');
  throw new Error(`GitHub returned ${res.status}.`);
}

/** Poll the published file until generatedAt moves past what we already have. */
async function waitForNewData(previousGeneratedAt) {
  const deadline = Date.now() + 5 * 60 * 1000;
  const started = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6000));
    status(`Scanning on GitHub… ${Math.round((Date.now() - started) / 1000)}s. This usually takes 1–3 minutes.`);
    try {
      const data = await fetchPayload();
      if (data.generatedAt !== previousGeneratedAt) return data;
    } catch { /* Pages can 404 briefly mid-deploy; keep waiting. */ }
  }
  throw new Error('Timed out waiting for the new scan. Check the Actions tab on GitHub.');
}

async function runScan() {
  if (isLocal) { await runScanLocally(); return; }

  const cfg = GH_KEY_STORE();
  if (!cfg?.token) { showSetup(); return; }

  const btn = $('scan-btn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  const previous = current?.generatedAt;
  try {
    status('Asking GitHub to start the scan…');
    await triggerWorkflow(cfg);
    render(await waitForNewData(previous));
    status('Updated.', 'ok');
  } catch (e) {
    if (/Token|permission|expired|not found/i.test(e.message)) showSetup(e.message);
    else status(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run new scan';
  }
}

/* ---------- Trading 212 connection (local server only) ----------
 * The key is posted to the local server, verified against Trading 212, then
 * stored in a gitignored file on this PC. It is never returned to the browser.
 */

async function refreshT212State() {
  if (!isLocal) {
    $('t212-setup').hidden = true;
    $('t212-connected').hidden = true;
    return;
  }
  try {
    const s = await fetch('/api/settings').then((r) => r.json());
    $('t212-setup').hidden = s.t212;
    $('t212-connected').hidden = !s.t212;
    if (s.t212) {
      $('t212-info').textContent = s.fromEnv
        ? `Connected via start-dashboard.bat (${s.hint})`
        : `Connected (${s.hint})`;
      $('t212-remove').hidden = s.fromEnv; // env-set keys are edited in the .bat
    }
  } catch {
    $('t212-setup').hidden = false;
    $('t212-connected').hidden = true;
  }
}

const t212Status = (msg, kind = '') => {
  const el = $('t212-status');
  el.textContent = msg;
  el.className = `scan-status ${kind}`;
};

$('t212-setup')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('t212-key').value.trim();
  const secret = $('t212-secret').value.trim();
  if (!key) { t212Status('Paste your API Key first.', 'err'); return; }

  const btn = $('t212-save');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  t212Status('Checking the key with Trading 212…');
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t212Key: key, t212Secret: secret }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Could not save the key.');

    $('t212-key').value = '';
    $('t212-secret').value = '';
    t212Status(`Connected to your ${body.accountType} account — ${body.positions} positions found. Running a scan…`, 'ok');
    await refreshT212State();
    await runScan();
  } catch (err) {
    t212Status(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
});

$('t212-remove')?.addEventListener('click', async () => {
  await fetch('/api/settings', { method: 'DELETE' });
  await refreshT212State();
  t212Status('Disconnected. Run a scan to clear the portfolio.', 'ok');
});

/* ---------- wiring ---------- */

$('refresh').addEventListener('click', refresh);
$('scan-btn').addEventListener('click', runScan);
$('gh-cancel').addEventListener('click', () => { $('gh-setup').hidden = true; status(''); });

$('gh-setup').addEventListener('submit', (e) => {
  e.preventDefault();
  const cfg = {
    owner: $('gh-owner').value.trim(),
    repo: $('gh-repo').value.trim(),
    token: $('gh-token').value.trim(),
    ref: 'main',
  };
  if (!cfg.owner || !cfg.repo || !cfg.token) { status('Fill in all three fields.', 'err'); return; }
  localStorage.setItem(GH_KEY, JSON.stringify(cfg));
  $('gh-setup').hidden = true;
  runScan();
});

/* ---------- the per-card calculators ---------- */

const stockByTicker = (t) =>
  [...(current?.longTerm ?? []), ...(current?.swingTerm ?? [])].find((s) => s.ticker === t);

/** Draw every calculator's output for its current price. */
function refreshCalcs() {
  document.querySelectorAll('.calc').forEach((box) => {
    const s = stockByTicker(box.dataset.ticker);
    if (s) renderCalc(box, s);
  });
}

// Delegated so it survives a re-render after each scan.
$('swing-cards').addEventListener('input', (e) => {
  const box = e.target.closest('.calc');
  if (!box) return;
  // The slider moves freely, so round what it reports before it becomes a price.
  const price = e.target.classList.contains('calc-slider')
    ? Number(e.target.value).toFixed(2)
    : e.target.value;
  // Keep the number field and the slider in step with each other.
  box.querySelectorAll('.calc-price, .calc-slider').forEach((el) => { el.value = price; });
  const s = stockByTicker(box.dataset.ticker);
  if (s) renderCalc(box, s);
});

const PANELS = ['long', 'swing', 'portfolio'];
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    PANELS.forEach((id) => { $(id).hidden = tab.dataset.target !== id; });
  });
});

load();
