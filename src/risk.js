// Risk level for every stock, built only from things we can actually measure:
// how much it moves, whether a binary event is imminent, how much history exists,
// and how far away the stop sits. Never a probability of any outcome.

const LEVELS = ['Low', 'Medium', 'High', 'Very high'];

/**
 * Returns { level, points, factors } where factors explains, in plain English,
 * every reason the level is what it is.
 */
export function assessRisk({ atrPct, earningsDate, sessions, stopFromTodayPct, volumeRatio, score, trailingPE, peerMedianPE }) {
  const factors = [];
  let points = 0;

  // 1. Day-to-day movement is the single biggest driver of how wrong this can go.
  if (atrPct != null) {
    if (atrPct > 6) { points += 3; factors.push(`Moves a lot day to day (${atrPct.toFixed(1)}% typical daily swing).`); }
    else if (atrPct > 4) { points += 2; factors.push(`Moves fairly sharply day to day (${atrPct.toFixed(1)}%).`); }
    else if (atrPct > 3) { points += 1; factors.push(`Moderate daily movement (${atrPct.toFixed(1)}%).`); }
    else factors.push(`Fairly steady day to day (${atrPct.toFixed(1)}%).`);
  }

  // 1b. A stretched valuation has further to fall if growth disappoints. This is
  // the main risk that separates otherwise similar large, stable companies.
  if (trailingPE && peerMedianPE) {
    const ratio = trailingPE / peerMedianPE;
    if (ratio > 2) { points += 2; factors.push(`Priced far above its sector peers (P/E ${trailingPE.toFixed(0)} vs ${peerMedianPE.toFixed(0)}), so disappointing results have a long way to fall.`); }
    else if (ratio > 1.4) { points += 1; factors.push(`Priced above its sector peers (P/E ${trailingPE.toFixed(0)} vs ${peerMedianPE.toFixed(0)}).`); }
  }

  // 2. Earnings are a coin flip no chart can read.
  if (earningsDate) {
    const days = Math.ceil((new Date(earningsDate) - Date.now()) / 86400000);
    if (days >= 0 && days <= 7) {
      points += 3;
      factors.push(`Earnings due in ${days} day${days === 1 ? '' : 's'}, which can move the price sharply either way.`);
    } else if (days > 7 && days <= 21) {
      points += 1;
      factors.push(`Earnings in about ${days} days.`);
    }
  }

  // 3. How much you would lose being wrong.
  if (stopFromTodayPct != null) {
    if (stopFromTodayPct > 15) { points += 2; factors.push(`The stop sits ${stopFromTodayPct}% below today's price, so being wrong costs a lot.`); }
    else if (stopFromTodayPct > 10) { points += 1; factors.push(`The stop is ${stopFromTodayPct}% away.`); }
  }

  // 4. Thin trading means harder fills and jumpier prices.
  if (volumeRatio != null && volumeRatio < 0.5) {
    points += 1;
    factors.push('Trading well below its usual volume, so there is little interest right now.');
  }

  // 5. Not enough history to judge anything reliably.
  if (sessions != null && sessions < 120) {
    points += 2;
    factors.push(`Only ${sessions} days of price history, so the signals are less reliable.`);
  }

  // 6. A weak setup is itself a risk.
  if (score != null && score < 4) {
    points += 1;
    factors.push('Scores poorly against our criteria, so there is little supporting it.');
  }

  const level = LEVELS[Math.min(LEVELS.length - 1, points <= 1 ? 0 : points <= 3 ? 1 : points <= 5 ? 2 : 3)];
  return { level, points, factors };
}

/**
 * Which of our swing criteria this stock meets today. Every item is a fact we can
 * check, not an opinion, so "meets 5 of 6" means something specific and verifiable.
 */
export function buildChecklist({ score, entry, trendScore, earningsDate, risk }) {
  const earningsSoon = earningsDate
    && (new Date(earningsDate) - Date.now()) / 86400000 <= 5
    && (new Date(earningsDate) - Date.now()) >= 0;

  const items = [
    { label: 'Scores 5.5 or better against our rules', met: score >= 5.5 },
    { label: 'Price is inside the entry zone right now', met: entry?.status === 'in-zone' },
    { label: 'Reward is at least 1.5x the risk', met: (entry?.rewardRisk ?? 0) >= 1.5 },
    { label: 'Medium-term trend is up', met: (trendScore ?? 0) >= 7 },
    { label: 'No earnings inside the next 5 days', met: !earningsSoon },
    { label: 'Risk level is Low or Medium', met: risk.level === 'Low' || risk.level === 'Medium' },
  ];

  const met = items.filter((i) => i.met).length;
  return { items, met, total: items.length, all: met === items.length };
}
