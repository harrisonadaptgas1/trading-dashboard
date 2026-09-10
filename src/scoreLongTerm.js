// Long-term scoring: is the multi-year trend intact, is the business growing,
// and is the price sane relative to peers?
import { last, sma, atr } from './indicators.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pct = (v) => `${(v * 100).toFixed(0)}%`;

/** Trend: the 200-day average is the classic long-term dividing line. */
function scoreTrend(closes) {
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  if (!s200.length) return { score: 5, note: 'Not enough history for a long-term trend read.' };

  const price = last(closes);
  const fast = last(s50);
  const slow = last(s200);
  // Is the 200-day average itself rising over the past month?
  const slowRising = s200.length > 21 && slow > s200[s200.length - 22];

  if (price > slow && fast > slow && slowRising) {
    return { score: 10, note: 'Long-term trend is firmly upward and still strengthening.' };
  }
  if (price > slow && fast > slow) return { score: 8.5, note: 'Trading above its long-term average in an established uptrend.' };
  if (price > slow) return { score: 7, note: 'Above its long-term average, though shorter-term momentum has cooled.' };
  if (fast > slow) return { score: 4, note: 'Recently dipped below its long-term average after a period of strength.' };
  return { score: 2, note: 'Below its long-term average, the multi-year trend has weakened.' };
}

/** Earnings growth: yfinance/Yahoo gives year-on-year quarterly growth. */
function scoreEarningsGrowth(f) {
  const g = f.earningsGrowth ?? f.earningsQuarterlyGrowth;
  if (g == null) return { score: 5, note: 'Earnings growth not available free, so treated as neutral.', missing: true };
  if (g > 0.25) return { score: 10, note: `Profits growing strongly, up ${pct(g)} on last year.` };
  if (g > 0.15) return { score: 8.5, note: `Profits up a solid ${pct(g)} on last year.` };
  if (g > 0.05) return { score: 7, note: `Profits growing modestly, up ${pct(g)} on last year.` };
  if (g >= 0) return { score: 5, note: `Profits broadly flat, up ${pct(g)} on last year.` };
  return { score: 2, note: `Profits shrinking, down ${pct(Math.abs(g))} on last year.` };
}

function scoreRevenueGrowth(f) {
  const g = f.revenueGrowth;
  if (g == null) return { score: 5, note: 'Revenue growth not available free, so treated as neutral.', missing: true };
  if (g > 0.20) return { score: 10, note: `Sales growing fast, up ${pct(g)} on last year.` };
  if (g > 0.10) return { score: 8.5, note: `Sales up a healthy ${pct(g)} on last year.` };
  if (g > 0.03) return { score: 6.5, note: `Sales growing steadily, up ${pct(g)} on last year.` };
  if (g >= 0) return { score: 5, note: `Sales roughly flat, up ${pct(g)} on last year.` };
  return { score: 2, note: `Sales declining, down ${pct(Math.abs(g))} on last year.` };
}

/**
 * Valuation. Yahoo does not expose a true sector median P/E on the free tier,
 * so we compare against the median of other watchlist stocks in the same sector.
 * Small sample, and labelled as such on the dashboard rather than dressed up.
 */
function scoreValuation(f, peerMedianPE) {
  const pe = f.trailingPE;
  if (pe == null || pe <= 0) {
    return { score: 5, note: 'No meaningful P/E available, so valuation treated as neutral.', missing: true };
  }
  if (!peerMedianPE) {
    return { score: 5, note: `P/E of ${pe.toFixed(0)}, but no watchlist peers in the same sector to compare against.` };
  }

  const ratio = pe / peerMedianPE;
  const vs = `P/E of ${pe.toFixed(0)} against a watchlist-sector median of ${peerMedianPE.toFixed(0)}`;
  let base;
  if (ratio < 0.8) base = { score: 9, note: `Cheaper than its watchlist peers, ${vs}.` };
  else if (ratio <= 1.1) base = { score: 7, note: `Priced in line with its watchlist peers, ${vs}.` };
  else if (ratio <= 1.5) base = { score: 5, note: `A bit pricier than its watchlist peers, ${vs}.` };
  else if (ratio <= 2) base = { score: 3, note: `Notably expensive next to its watchlist peers, ${vs}.` };
  else base = { score: 2, note: `Very expensive next to its watchlist peers, ${vs}.` };

  // Forward P/E well below trailing means the market expects earnings to grow into the price.
  if (f.forwardPE && f.forwardPE < pe * 0.9) {
    base.score = clamp(base.score + 1, 0, 10);
    base.note += ' Analysts expect earnings to grow into that price.';
  }
  return base;
}

export function scoreLongTermStock(data, news, config, peerMedianPE) {
  const { weights } = config.longTerm;
  const f = data.fundamentals;
  const { closes, highs, lows } = data.series;

  // Volatility is not part of the long-term score, but the risk assessment needs
  // it, and without it every long-term stock came out as "Low risk".
  const atrSeries = atr(highs, lows, closes, 14);
  const atrPct = atrSeries.length ? (last(atrSeries) / last(closes)) * 100 : null;

  const parts = {
    trend: scoreTrend(data.series.closes),
    earningsGrowth: scoreEarningsGrowth(f),
    revenueGrowth: scoreRevenueGrowth(f),
    valuation: scoreValuation(f, peerMedianPE),
  };

  const score = Object.entries(weights)
    .reduce((sum, [key, w]) => sum + parts[key].score * w, 0) / 100;

  const warnings = [];
  const missing = Object.entries(parts).filter(([, v]) => v.missing).map(([k]) => k);
  if (missing.length) warnings.push(`Some data unavailable free (${missing.join(', ')}), scored as neutral.`);
  if (news.summary.net <= -0.25) warnings.push('Recent headlines are clearly negative, worth a read before acting.');

  return {
    score: Number(clamp(score, 0, 10).toFixed(1)),
    reason: buildReason(parts),
    breakdown: Object.fromEntries(
      Object.entries(parts).map(([k, v]) => [k, { score: Number(v.score.toFixed(1)), weight: weights[k], note: v.note }])
    ),
    warnings,
    metrics: { trailingPE: f.trailingPE, forwardPE: f.forwardPE, earningsGrowth: f.earningsGrowth, revenueGrowth: f.revenueGrowth, atrPct },
  };
}

/** Lead with the trend, then the strongest other factor, plus a clear negative if present. */
function buildReason(parts) {
  const others = [parts.earningsGrowth, parts.revenueGrowth, parts.valuation].sort((a, b) => b.score - a.score);
  const picked = [parts.trend, others[0]];
  const worst = others[others.length - 1];
  if (worst.score <= 3 && !picked.includes(worst)) picked.push(worst);
  return picked.map((p) => p.note).join(' ');
}
