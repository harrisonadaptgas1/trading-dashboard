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
export function runBacktest(series, computeEntry, options = {}) {
  // Where in the entry zone to buy: 0 = the bottom, 1 = the top. Buying lower
  // puts the stop further away in percentage terms, so it is genuinely less
  // likely to be hit — which is why this is measured rather than assumed.
  const { entryPosition = null } = options;
  const { closes, highs, lows } = series;
  if (closes.length < MIN_BARS + MAX_HOLD) {
    return { occurrences: 0, wins: 0, losses: 0, unresolved: 0, hitRate: null, reason: 'not enough history' };
  }

  let wins = 0, losses = 0, unresolved = 0, occurrences = 0, totalHeld = 0;
  // How long each outcome took. Kept apart because they differ: a loss arrives
  // quickly, while a win has to travel twice as far and takes roughly twice as long.
  const winBars = [], lossBars = [];
  // Snapshots of how far between stop and target each trade stood while it was
  // open, in tenths, so we can ask later what happened to trades that got this far.
  const progress = [];
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

    // Default behaviour enters at the signal bar's close with the levels as
    // published. With an entryPosition we instead buy at that point in the zone
    // and take a 2:1 target on the risk that entry carries, exactly as the
    // calculator on the card does.
    let entry, stopLoss, exit;
    if (entryPosition == null) {
      entry = closes[i];
      ({ stopLoss, exit } = levels);
    } else {
      entry = levels.low + (levels.high - levels.low) * entryPosition;
      stopLoss = levels.stopLoss;
      const risk = entry - stopLoss;
      if (risk <= 0) { i++; occurrences--; continue; }
      exit = entry + risk * 2;
    }

    let resolved = false;
    let held = 0;
    const path = [];
    for (let j = i + 1; j < Math.min(i + 1 + MAX_HOLD, closes.length); j++) {
      held = j - i;
      const hitStop = lows[j] <= stopLoss;
      const hitTarget = highs[j] >= exit;

      // Both in one bar: we cannot know the order intraday, so assume the worse.
      if (hitStop) { losses++; lossBars.push(held); resolved = true; break; }
      if (hitTarget) { wins++; winBars.push(held); resolved = true; break; }

      const fraction = (closes[j] - stopLoss) / (exit - stopLoss);
      path.push(Math.max(0, Math.min(9, Math.floor(fraction * 10))));
    }

    if (!resolved) unresolved++;
    const outcome = !resolved ? 'open' : winBars[winBars.length - 1] === held ? 'win' : 'loss';
    for (const bucket of path) progress.push([bucket, outcome]);
    totalHeld += held;

    // Skip past this trade so overlapping signals are not double counted.
    i += Math.max(held, 1);
  }

  // Median, not mean: one setup that crawled to its target for a month should not
  // drag the typical case with it.
  const median = (list) => {
    if (!list.length) return null;
    const sorted = [...list].sort((x, y) => x - y);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };

  const decided = wins + losses;
  return {
    occurrences,
    wins,
    losses,
    unresolved,
    hitRate: decided >= 1 ? Number((wins / decided).toFixed(3)) : null,
    avgBarsHeld: occurrences ? Math.round(totalHeld / occurrences) : null,
    // Trading days to each outcome, and how often neither arrived inside maxHold.
    progress,
    winDays: median(winBars),
    lossDays: median(lossBars),
    unresolvedPct: occurrences ? Math.round((unresolved / occurrences) * 100) : null,
    // Below roughly 10 decided trades the rate is noise, and should be shown as such.
    reliable: decided >= 10,
  };
}
