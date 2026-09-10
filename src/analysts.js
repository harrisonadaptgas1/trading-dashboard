// Analyst price targets, plus a reality check against the stock's own history.
//
// Sell-side price targets are a 12-month convention: analysts do not publish
// varied horizons, so we do not invent one. Instead, for the upside a target
// implies, we measure how long THIS stock has historically taken to move that far.
// That is the honest answer to "how long might this take".

const TRADING_DAYS = { '3 months': 63, '6 months': 126, '12 months': 252 };

const pct = (a, b) => ((a - b) / b) * 100;

/** Every rolling return over `window` trading days. */
function rollingReturns(closes, window) {
  const out = [];
  for (let i = window; i < closes.length; i++) {
    out.push(pct(closes[i], closes[i - window]));
  }
  return out;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * For the implied upside, find the shortest horizon where this stock has
 * historically delivered at least that much in more than half of all periods.
 * Returns null when even 12 months has not typically got there.
 */
function historicalHorizon(closes, upsidePct) {
  const horizons = [];
  for (const [label, window] of Object.entries(TRADING_DAYS)) {
    if (closes.length < window + 30) continue;
    const returns = rollingReturns(closes, window);
    const hit = returns.filter((r) => r >= upsidePct).length / returns.length;
    horizons.push({
      label,
      medianReturn: Number(median(returns).toFixed(1)),
      // Share of past periods of this length that delivered the target's upside.
      hitRate: Number((hit * 100).toFixed(0)),
      periods: returns.length,
    });
  }
  const reached = horizons.find((h) => h.medianReturn >= upsidePct);
  return { horizons, typicalHorizon: reached?.label ?? null };
}

/**
 * Combine Yahoo's analyst consensus with the historical check.
 * Every field is optional: missing analyst coverage is normal and not an error.
 */
export function buildAnalystView(fundamentals, price, closes) {
  const {
    targetMeanPrice: mean, targetLowPrice: low, targetHighPrice: high,
    numberOfAnalystOpinions: count, recommendationKey: rec,
  } = fundamentals;

  if (!mean || !price) return null;

  const upside = pct(mean, price);
  const { horizons, typicalHorizon } = historicalHorizon(closes, upside);

  return {
    mean: Number(mean.toFixed(2)),
    low: low ? Number(low.toFixed(2)) : null,
    high: high ? Number(high.toFixed(2)) : null,
    count: count ?? null,
    recommendation: rec ? rec.replace(/_/g, ' ') : null,
    upsidePct: Number(upside.toFixed(1)),
    // How far apart the most and least optimistic analysts are, as a share of
    // price. A wide spread means "target" is really a midpoint of disagreement.
    spreadPct: low && high ? Number(pct(high, low).toFixed(0)) : null,
    horizon: '12 months',
    typicalHorizon,
    horizons,
  };
}
