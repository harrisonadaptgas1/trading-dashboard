// Swing scoring. Philosophy: reward pullbacks inside an uptrend and oversold stocks
// that have started turning. Penalise chasing extended moves and catching falling knives.
import { last, sma, ema, rsi, atr, pctReturn, volumeRatio, recentCross } from './indicators.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** A. Momentum gauge (RSI) and, crucially, which way it is heading. */
function scoreRsi(closes) {
  const series = rsi(closes, 14);
  if (series.length < 4) return { score: 5, note: 'Not enough history to judge momentum.', value: null };
  const now = last(series);
  const rising = now > series[series.length - 4];
  const dir = rising ? 'and recovering' : 'and still falling';
  const v = now.toFixed(0);

  if (now >= 70) return { score: 1.5, note: `Looks stretched after a strong run (momentum gauge ${v}/100).`, value: now };
  if (now >= 60) return { score: 4, note: `Already run up a fair way (momentum gauge ${v}/100).`, value: now };
  if (now < 30) return { score: rising ? 8 : 6, note: `Heavily sold off ${dir} (momentum gauge ${v}/100).`, value: now };
  if (now < 35) return { score: rising ? 8.5 : 6, note: `Sold off ${dir} (momentum gauge ${v}/100).`, value: now };
  if (now <= 50) return { score: rising ? 9.5 : 6, note: `In the buy-zone ${dir} (momentum gauge ${v}/100).`, value: now };
  return { score: rising ? 7 : 5, note: `Middle of the range ${dir} (momentum gauge ${v}/100).`, value: now };
}

/** B. Where price sits against its short and medium averages. */
function scoreTrend(closes) {
  const e20 = ema(closes, 20);
  const s50 = sma(closes, 50);
  if (!e20.length || !s50.length) return { score: 5, note: 'Not enough history to judge the trend.' };

  const price = last(closes);
  const fast = last(e20);
  const slow = last(s50);
  const cross = recentCross(e20, s50, 10);

  if (cross === 'bullish') return { score: 10, note: 'Short-term average has just crossed above the medium-term one, a fresh turn upward.' };
  if (cross === 'bearish') return { score: 1, note: 'Short-term average has just crossed below the medium-term one, trend turning down.' };
  if (price > fast && fast > slow) return { score: 8, note: 'Trading above both its short and medium-term averages, a healthy uptrend.' };
  if (price > slow && price < fast) return { score: 7, note: 'Dipped below its short-term average while the medium-term trend still points up, a classic pullback.' };
  if (price > fast && fast < slow) return { score: 5, note: 'Starting to recover, but the medium-term trend has not turned yet.' };
  if (price < fast && fast < slow) return { score: 2, note: 'Below both averages, still in a downtrend.' };
  return { score: 4, note: 'Trend is unclear right now.' };
}

/** C. Volume only means something in the direction price moved. */
function scoreVolume(closes, volumes) {
  const ratio = volumeRatio(volumes, 20);
  if (ratio == null) return { score: 5, note: 'Not enough volume history.', value: null };
  const up = closes[closes.length - 1] > closes[closes.length - 2];
  const x = ratio.toFixed(1);

  if (ratio >= 2 && up) return { score: 10, note: `Unusually heavy buying, ${x}x normal volume on an up day.`, value: ratio };
  if (ratio >= 1.5 && up) return { score: 8, note: `Above-average buying, ${x}x normal volume on an up day.`, value: ratio };
  if (ratio >= 1.5 && !up) return { score: 2, note: `Heavy selling, ${x}x normal volume on a down day.`, value: ratio };
  if (ratio < 0.6) return { score: 4, note: `Very quiet, only ${x}x normal volume and little interest.`, value: ratio };
  return { score: 5, note: `Normal trading volume (${x}x average).`, value: ratio };
}

/** D. Buy the dip inside the trend; do not chase what has already run. */
function scoreMomentum(closes) {
  const r5 = pctReturn(closes, 5);
  const r20 = pctReturn(closes, 20);
  if (r5 == null || r20 == null) return { score: 5, note: 'Not enough history to judge momentum.' };
  const w = `${r5 >= 0 ? 'up' : 'down'} ${Math.abs(r5).toFixed(1)}% this week`;
  const m = `${r20 >= 0 ? 'up' : 'down'} ${Math.abs(r20).toFixed(1)}% over the month`;

  if (r20 > 0 && r5 <= -1 && r5 >= -6) return { score: 9, note: `${cap(w)} but ${m}, pulling back inside an uptrend.` };
  // A big one-week jump is a spike to chase, not a trend to join, even if the
  // month looks calm. Catch this before the "steady climb" branch below.
  if (r5 > 10) return { score: 3, note: `${cap(w)}, a sharp jump that would mean buying after the move.` };
  if (r5 > 6) return { score: 4.5, note: `${cap(w)}, already moved quickly in the short term.` };
  if (r20 > 25) return { score: 4, note: `${cap(m)}, a big move already and late to the party.` };
  if (r20 > 3 && r20 <= 15 && r5 > 0) return { score: 7, note: `${cap(m)} and ${w}, a steady climb.` };
  if (r20 > 0 && r5 > 0) return { score: 6, note: `${cap(m)} and ${w}.` };
  if (r20 < 0 && r5 > 0) return { score: 5, note: `${cap(w)} after being ${m}, possibly turning.` };
  if (r20 < 0 && r5 < 0) return { score: 2, note: `${cap(m)} and ${w}, still sliding.` };
  return { score: 5, note: `${cap(m)}, ${w}.` };
}

/** E. News tilt, deliberately capped low because free sentiment is the weakest input. */
function scoreNews(summary) {
  if (!summary || summary.label === 'no recent news') {
    return { score: 5, note: 'No fresh headlines in the last 48 hours.' };
  }
  const score = clamp(5 + summary.net * 5, 1, 9);
  return { score, note: `Recent headlines are ${summary.label} (${summary.positive} positive, ${summary.negative} negative).` };
}

const round = (v) => Number(v.toFixed(2));

/**
 * Chart-derived entry levels. These are arithmetic on past prices, not forecasts:
 * a zone where our pullback rules would consider the setup live, and the level below
 * which the setup has stopped being what we described.
 *
 * Anchored on the 20-day average (the pullback magnet in an uptrend), floored at the
 * recent low, and widened by ATR so the band reflects how much the stock actually moves.
 */
export function computeEntry(closes, highs, lows) {
  const e20 = last(ema(closes, 20));
  const s50 = last(sma(closes, 50));
  const a = last(atr(highs, lows, closes, 14));
  if (!e20 || !s50 || !a) return null;

  const price = last(closes);
  const recentLow = Math.min(...lows.slice(-10));
  const recentHigh = Math.max(...highs.slice(-20));
  const uptrend = price > s50;

  // Our rules only describe pullbacks inside an uptrend. Below the medium-term
  // average there is no setup to put a level on, so we say so rather than invent one.
  if (!uptrend && price < e20) {
    return {
      status: 'none',
      recentHigh: round(recentHigh),
      note: 'No entry level flagged: the stock is below its medium-term average, which is not a setup our rules describe.',
    };
  }

  let low, high, context;
  if (uptrend && price <= e20) {
    low = Math.max(recentLow, price - a);
    high = price + a * 0.25;
    context = 'It has already pulled back to its short-term average.';
  } else if (uptrend) {
    low = Math.max(recentLow, e20 - a * 0.5);
    high = e20 + a * 0.5;
    context = 'It is trading above its short-term average.';
  } else {
    low = price - a * 0.75;
    high = price + a * 0.25;
    context = 'It is recovering but still below its medium-term average, so this is a less established setup.';
  }

  if (low >= high) low = high - a * 0.25;

  const breaksBelow = Math.min(low - a, recentLow - a * 0.25);
  const inZone = price >= low && price <= high;

  // Exit target. Prefer the recent 20-day high: a level the stock has actually
  // turned at, rather than a number invented from a multiple. If that sits too
  // close to be worth the risk taken, fall back to twice the risk instead.
  const mid = (low + high) / 2;
  const risk = mid - breaksBelow;
  let exit = recentHigh;
  let exitBasis = 'the recent 20-day high, a level it has turned at before';
  if (risk > 0 && exit - mid < risk) {
    exit = mid + risk * 2;
    exitBasis = 'twice the distance to the break level, because the recent high is too close to be worth the risk';
  }
  const rewardRisk = risk > 0 ? (exit - mid) / risk : null;

  // Word the note from the computed status, not the branch: a stock above its
  // 20-day average can still sit inside the band, and saying "wait for a dip"
  // next to an "in the zone now" badge contradicts itself.
  // The risk figures above assume entry inside the zone. Buying at today's price
  // instead gives a different stop distance, so state that separately rather than
  // letting a zone-based percentage be read as today's risk.
  const stopFromTodayPct = Number((((price - breaksBelow) / price) * 100).toFixed(1));

  // Each entry gets its own exit, set at the same 2:1 payoff on the risk that
  // entry actually carries. Holding the ratio constant makes the cost of paying
  // more concrete: the move required grows, and past a point the target needs a
  // new 20-day high, which is a far higher bar than simply retesting the old one.
  const ladder = [['Bottom', low], ['Middle', (low + high) / 2], ['Top', high]]
    .map(([label, p]) => {
      const risk = p - breaksBelow;
      const target = p + risk * 2;
      return {
        label,
        price: round(p),
        exit: round(target),
        movePct: Number((((target - p) / p) * 100).toFixed(1)),
        lossPct: Number((((p - breaksBelow) / p) * 100).toFixed(1)),
        // Does this target need a fresh high, or just a return to the old one?
        needsNewHigh: target > recentHigh,
      };
    });

  const note = `${context} ${inZone
    ? 'Today’s price sits inside that zone.'
    : 'Reaching the zone would mean waiting for a dip.'} The exit level is ${exitBasis}.` +
    (inZone ? '' : ` Buying at today’s price rather than in the zone would put the stop ${stopFromTodayPct}% away instead.`);

  return {
    status: inZone ? 'in-zone' : 'wait',
    low: round(low),
    high: round(high),
    exit: round(exit),
    // The stop loss: below this, the setup we described is no longer true.
    stopLoss: round(breaksBelow),
    recentHigh: round(recentHigh),
    // How far price would have to fall to reach the top of the zone.
    fallToZonePct: inZone ? 0 : Number((((price - high) / price) * 100).toFixed(1)),
    riskPct: Number((((high - breaksBelow) / high) * 100).toFixed(1)),
    stopFromTodayPct,
    ladder,
    // Gain from the middle of the zone to the exit, as a percentage.
    rewardPct: Number((((exit - mid) / mid) * 100).toFixed(1)),
    rewardRisk: rewardRisk == null ? null : Number(rewardRisk.toFixed(1)),
    note,
  };
}

export function scoreSwingStock(data, news, config) {
  const { weights, modifiers } = config.swing;
  const { closes, highs, lows, volumes } = data.series;

  const parts = {
    rsi: scoreRsi(closes),
    trend: scoreTrend(closes),
    volume: scoreVolume(closes, volumes),
    momentum: scoreMomentum(closes),
    news: scoreNews(news.summary),
  };

  let score = Object.entries(weights)
    .reduce((sum, [key, w]) => sum + parts[key].score * w, 0) / 100;

  const warnings = [];

  // Modifier: earnings imminent, a coin flip no chart can predict.
  const earningsDate = data.fundamentals.earningsDate;
  if (earningsDate) {
    const days = (new Date(earningsDate) - Date.now()) / 86400000;
    if (days >= 0 && days <= modifiers.earningsWithinDays) {
      score *= modifiers.earningsMultiplier;
      warnings.push(`Earnings due ${fmtDate(earningsDate)}, results are unpredictable.`);
    }
  }

  // Modifier: volatility is risk, not opportunity.
  const atrSeries = atr(highs, lows, closes, 14);
  const atrPct = atrSeries.length ? (last(atrSeries) / last(closes)) * 100 : null;
  if (atrPct != null) {
    if (atrPct > modifiers.highVolatilityAtrPct) {
      score *= modifiers.highVolatilityMultiplier;
      warnings.push(`Moves sharply day to day (${atrPct.toFixed(1)}% average daily swing).`);
    } else if (atrPct < modifiers.lowVolatilityAtrPct) {
      score *= modifiers.lowVolatilityMultiplier;
      warnings.push('Barely moves day to day, little for a short-term trade to work with.');
    }
  }

  // Modifier: thin data cannot be trusted.
  if (closes.length < modifiers.minSessions) {
    score = Math.min(score, modifiers.thinDataCap);
    warnings.push(`Only ${closes.length} days of price history available.`);
  }

  return {
    score: Number(clamp(score, 0, 10).toFixed(1)),
    reason: buildReason(parts),
    breakdown: Object.fromEntries(
      Object.entries(parts).map(([k, v]) => [k, { score: Number(v.score.toFixed(1)), weight: weights[k], note: v.note }])
    ),
    warnings,
    entry: computeEntry(closes, highs, lows),
    metrics: { rsi: parts.rsi.value, volumeRatio: parts.volume.value, atrPct },
  };
}

/**
 * Plain-English summary. Always anchor on the trend so a card explains its chart
 * situation first; a headline alone is never the headline reason for a swing setup.
 */
function buildReason(parts) {
  const others = [parts.rsi, parts.volume, parts.momentum, parts.news].sort((a, b) => b.score - a.score);
  const picked = [parts.trend, others[0]];
  const worst = others[others.length - 1];
  if (worst.score <= 2.5 && !picked.includes(worst)) picked.push(worst);
  return picked.map((p) => p.note).join(' ');
}
