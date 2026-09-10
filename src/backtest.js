// Historical hit rate for the swing setup.
//
// Walks back through two years of daily bars, finds every past day where our
// entry rules would have fired, and checks what happened next: did price reach
// the exit target before the stop loss?
//
// This is a measured hit rate, NOT a probability of future profit. It says what
// happened before, on this stock, under these rules. Nothing more.
//
// Rules of the exercise, chosen to avoid flattering the result:
//   - Only data up to and including the signal bar is used (no lookahead).
//   - Entry is the close of the signal bar.
//   - If a bar touches both the stop and the target, it counts as a LOSS.
//   - Overlapping signals are skipped until the open trade resolves.
//   - A trade still open after maxHold bars is "unresolved", not a win.

const MAX_HOLD = 30;      // trading days before we give up on a setup
const MIN_BARS = 80;      // need enough history for the indicators to be valid

/**
 * @param {{closes:number[],highs:number[],lows:number[]}} series
 * @param {(closes:number[],highs:number[],lows:number[]) => object|null} computeEntry
 */
export function runBacktest(series, computeEntry) {
  const { closes, highs, lows } = series;
  if (closes.length < MIN_BARS + MAX_HOLD) {
    return { occurrences: 0, wins: 0, losses: 0, unresolved: 0, hitRate: null, reason: 'not enough history' };
  }

  let wins = 0, losses = 0, unresolved = 0, occurrences = 0, totalHeld = 0;
  let i = MIN_BARS;

  while (i < closes.length - 1) {
    // Levels exactly as the live dashboard would have computed them that day.
    const levels = computeEntry(
      closes.slice(0, i + 1),
      highs.slice(0, i + 1),
      lows.slice(0, i + 1)
    );

    // Only count days the setup was actually live, matching the dashboard's
    // "price is in the zone now" state.
    if (!levels || levels.status !== 'in-zone') { i++; continue; }

    occurrences++;
    const entry = closes[i];
    const { stopLoss, exit } = levels;

    let resolved = false;
    let held = 0;
    for (let j = i + 1; j < Math.min(i + 1 + MAX_HOLD, closes.length); j++) {
      held = j - i;
      const hitStop = lows[j] <= stopLoss;
      const hitTarget = highs[j] >= exit;

      // Both in one bar: we cannot know the order intraday, so assume the worse.
      if (hitStop) { losses++; resolved = true; break; }
      if (hitTarget) { wins++; resolved = true; break; }
    }

    if (!resolved) unresolved++;
    totalHeld += held;

    // Skip past this trade so overlapping signals are not double counted.
    i += Math.max(held, 1);
  }

  const decided = wins + losses;
  return {
    occurrences,
    wins,
    losses,
    unresolved,
    hitRate: decided >= 1 ? Number((wins / decided).toFixed(3)) : null,
    avgBarsHeld: occurrences ? Math.round(totalHeld / occurrences) : null,
    // Below roughly 10 decided trades the rate is noise, and should be shown as such.
    reliable: decided >= 10,
  };
}
