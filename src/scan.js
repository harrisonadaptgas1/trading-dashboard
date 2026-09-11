// Daily scan: fetch -> score -> write public/data/latest.json
//
//   node src/scan.js                       full watchlist
//   node src/scan.js --tickers=AAPL,TSLA   just these
//   node src/scan.js --limit=3             first 3 of each category
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { yf, getStockData, mapWithLimit } from './yahoo.js';
import { getNews } from './news.js';
import { scoreSwingStock, computeEntry } from './scoreSwing.js';
import { scoreLongTermStock } from './scoreLongTerm.js';
import { getPortfolio, fetchInstruments, getOrders } from './trading212.js';
import { getT212Credentials } from './secrets.js';
import { resolveInstrument, getFxRate, loadT212Metadata } from './instruments.js';
import { assessRisk, buildChecklist } from './risk.js';
import { runBacktest } from './backtest.js';
import { buildAnalystView } from './analysts.js';
import { runHealthCheck } from './healthCheck.js';
import { rememberStop, pruneStops } from './positionPlans.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (p) => JSON.parse(await readFile(join(ROOT, p), 'utf8'));

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
  );
  return {
    tickers: args.tickers ? args.tickers.split(',').map((t) => t.trim().toUpperCase()) : null,
    limit: args.limit ? Number(args.limit) : null,
  };
}

/** Median trailing P/E per sector, used as the (clearly labelled) valuation yardstick. */
function sectorMedianPE(stocks) {
  const bySector = {};
  for (const s of stocks) {
    const { sector, trailingPE } = s.fundamentals;
    if (!sector || !trailingPE || trailingPE <= 0) continue;
    (bySector[sector] ??= []).push(trailingPE);
  }
  return Object.fromEntries(
    Object.entries(bySector)
      .filter(([, pes]) => pes.length >= 2) // one stock is not a peer group
      .map(([sector, pes]) => {
        const sorted = [...pes].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        return [sector, median];
      })
  );
}

async function collect(entries, config) {
  return mapWithLimit(entries, 3, async (entry) => {
    try {
      const [data, news] = await Promise.all([
        getStockData(entry),
        getNews(yf, entry, config.news),
      ]);
      console.log(`  ${entry.ticker.padEnd(6)} ok    ${data.price.toFixed(2).padEnd(9)} ${news.headlines.length} headlines`);
      return { data, news };
    } catch (err) {
      console.log(`  ${entry.ticker.padEnd(6)} FAILED ${err.message}`);
      return { error: { ticker: entry.ticker, name: entry.name, message: err.message } };
    }
  });
}

/**
 * How the setup performed depending on where in the entry zone you bought.
 *
 * Each point is a separate backtest, but each rests on only 10-30 past trades,
 * so one trade flipping moves a point by several percent. Reading those raw
 * points straight off made the calculator jump up and down as you dragged the
 * slider, implying detail the evidence does not support. The decline itself is
 * consistent across every stock, so we fit a straight line through the points
 * and quote that: the same measured trend, without the noise.
 */
const median = (list) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

function buildEntryCurve(series) {
  const points = [0, 0.25, 0.5, 0.75, 1].map((position) => {
    const r = runBacktest(series, computeEntry, { entryPosition: position });
    return {
      position, hitRate: r.hitRate, decided: r.wins + r.losses, avgBarsHeld: r.avgBarsHeld,
      winDays: r.winDays, lossDays: r.lossDays, unresolvedPct: r.unresolvedPct,
    };
  });

  // Time to a win stretches the higher you buy, because the target moves further
  // away while the stop stays put. Time to a loss barely moves, so that is taken
  // as one figure rather than fitted.
  const fitLine = (list, value) => {
    const pts = list.filter((p) => value(p) != null);
    if (pts.length < 2) return null;
    const meanX = pts.reduce((a, p) => a + p.position, 0) / pts.length;
    const meanY = pts.reduce((a, p) => a + value(p), 0) / pts.length;
    const varX = pts.reduce((a, p) => a + (p.position - meanX) ** 2, 0);
    if (varX === 0) return null;
    const slope = pts.reduce((a, p) => a + (p.position - meanX) * (value(p) - meanY), 0) / varX;
    return { intercept: Number((meanY - slope * meanX).toFixed(4)), slope: Number(slope.toFixed(4)) };
  };

  const usable = points.filter((p) => p.hitRate != null);
  if (usable.length < 2) return null;

  const meanX = usable.reduce((a, p) => a + p.position, 0) / usable.length;
  const meanY = usable.reduce((a, p) => a + p.hitRate, 0) / usable.length;
  const varX = usable.reduce((a, p) => a + (p.position - meanX) ** 2, 0);
  if (varX === 0) return null;
  const slope = usable.reduce((a, p) => a + (p.position - meanX) * (p.hitRate - meanY), 0) / varX;

  const counts = usable.map((p) => p.decided);
  return {
    points,
    fit: {
      intercept: Number((meanY - slope * meanX).toFixed(4)),
      slope: Number(slope.toFixed(4)),
    },
    trades: { min: Math.min(...counts), max: Math.max(...counts) },
    winDaysFit: fitLine(points, (p) => p.winDays),
    lossDays: median(points.map((p) => p.lossDays).filter((d) => d != null)),
    unresolvedPct: median(points.map((p) => p.unresolvedPct).filter((d) => d != null)),
  };
}
function toCard(data, news, scored, config, peerMedianPE) {
  const n = config.chart.sparklineDays;

  const risk = assessRisk({
    atrPct: scored.metrics.atrPct ?? null,
    earningsDate: data.fundamentals.earningsDate,
    sessions: data.series.closes.length,
    stopFromTodayPct: scored.entry?.stopFromTodayPct ?? null,
    volumeRatio: scored.metrics.volumeRatio ?? null,
    score: scored.score,
    trailingPE: data.fundamentals.trailingPE,
    peerMedianPE,
  });

  // How this setup has actually performed on this stock before. Swing only:
  // long-term holdings have no target-or-stop outcome to measure.
  const backtest = scored.entry ? runBacktest(data.series, computeEntry) : null;

  // Measured hit rate at five points across the entry zone, so the calculator
  // on the card can report a real number for the price you type rather than
  // reusing one figure regardless of what you pay.
  const entryCurve = scored.entry?.status && scored.entry.status !== 'none'
    ? buildEntryCurve(data.series)
    : null;
  // Hit rate alone is misleading: 45% with a 2:1 payoff beats 60% with 1:1.
  // Combine the measured hit rate with today's actual reward and risk to get the
  // average outcome per setup, in percent. Still backward-looking, but it is the
  // one figure that accounts for both being right and being paid.
  if (backtest?.hitRate != null && scored.entry?.rewardPct != null) {
    const p = backtest.hitRate;
    backtest.expectancyPct = Number(
      (p * scored.entry.rewardPct - (1 - p) * scored.entry.riskPct).toFixed(2)
    );
  }

  // The checklist only means anything for swing setups, which have entry levels.
  const checklist = scored.entry
    ? buildChecklist({
        score: scored.score,
        entry: scored.entry,
        trendScore: scored.breakdown.trend?.score,
        earningsDate: data.fundamentals.earningsDate,
        risk,
      })
    : null;

  // Analyst consensus is a long-term signal; swing setups run on days, not a
  // 12-month view, so it would be noise there.
  const analysts = scored.entry ? null : buildAnalystView(data.fundamentals, data.price, data.series.closes);

  return {
    risk,
    checklist,
    backtest,
    entryCurve,
    analysts,
    ticker: data.ticker,
    name: data.name,
    price: Number(data.price.toFixed(2)),
    currency: data.fundamentals.currency,
    changePct: Number(data.changePct.toFixed(2)),
    asOf: data.asOf,
    live: data.live,
    lastClose: data.lastClose == null ? null : Number(data.lastClose.toFixed(2)),
    sector: data.fundamentals.sector,
    score: scored.score,
    reason: scored.reason,
    breakdown: scored.breakdown,
    warnings: scored.warnings,
    entry: scored.entry ?? null,
    metrics: scored.metrics,
    sparkline: data.series.closes.slice(-n).map((v) => Number(v.toFixed(2))),
    newsSummary: news.summary,
    headlines: news.headlines.slice(0, config.news.displayHeadlines).map((h) => ({
      title: h.title,
      link: h.link,
      publisher: h.publisher,
      published: h.published,
      label: h.sentiment.label,
      catalyst: h.sentiment.catalyst,
    })),
  };
}

/**
 * The exit plan for a holding you already own.
 *
 * The stop is a level on the chart, so it is the same one the watchlist card
 * shows — it does not care what you paid. The target does: it takes twice the
 * risk your own fill price carries, which is the same 2:1 rule the calculator
 * uses, so someone who paid more has further to travel for the same payoff.
 */
async function buildPositionPlan(pos, card) {
  const entry = card?.entry;
  if (!entry || entry.status === 'none' || pos.averagePrice == null) return null;

  const paid = pos.averagePrice;
  // Frozen the first time this position is seen, and reused forever after.
  const remembered = await rememberStop(pos, entry.stopLoss);
  const stopLoss = remembered?.stopLoss ?? entry.stopLoss;
  const risk = paid - stopLoss;
  // Already below the level that says the setup is broken: a 2:1 target off a
  // negative risk would be nonsense, so report the breach instead of inventing one.
  if (risk <= 0) {
    return { stopLoss, target: null, breached: true, recentHigh: entry.recentHigh,
             setAt: remembered?.setAt ?? null, currentLevel: entry.stopLoss };
  }

  const target = paid + risk * 2;
  const qty = pos.quantity ?? 0;
  return {
    stopLoss: Number(stopLoss.toFixed(2)),
    target: Number(target.toFixed(2)),
    breached: false,
    setAt: remembered?.setAt ?? null,
    // Where the rules would put the stop today, so a drift away from the level
    // you are actually holding to is visible rather than hidden.
    currentLevel: Number(entry.stopLoss.toFixed(2)),
    lossPct: Number(((risk / paid) * 100).toFixed(1)),
    gainPct: Number((((target - paid) / paid) * 100).toFixed(1)),
    lossAmount: Number((risk * qty).toFixed(2)),
    gainAmount: Number((risk * 2 * qty).toFixed(2)),
    // How far today's price sits from each level, which is what you watch.
    toStopPct: pos.currentPrice == null ? null
      : Number((((pos.currentPrice - stopLoss) / pos.currentPrice) * 100).toFixed(1)),
    toTargetPct: pos.currentPrice == null ? null
      : Number((((target - pos.currentPrice) / pos.currentPrice) * 100).toFixed(1)),
    needsNewHigh: entry.recentHigh != null && target > entry.recentHigh,
    recentHigh: entry.recentHigh,
    winDays: card.entryCurve?.winDaysFit
      ? Math.max(1, Math.round(card.entryCurve.winDaysFit.intercept + card.entryCurve.winDaysFit.slope))
      : null,
  };
}
/**
 * Once a trade is open, how far it has travelled says a great deal about how it
 * ends. Pooled across every swing stock, because this is a fact about the shape
 * of these trades rather than about any one company — and pooling turns a dozen
 * samples per stock into several hundred.
 */
function buildProgressCurve(cards) {
  const tally = Array.from({ length: 10 }, () => ({ win: 0, loss: 0, open: 0 }));
  for (const card of cards) {
    for (const [bucket, outcome] of card.backtest?.progress ?? []) tally[bucket][outcome]++;
  }
  return tally.map((t, i) => {
    const decided = t.win + t.loss;
    return {
      from: i / 10,
      to: (i + 1) / 10,
      hitRate: decided >= 20 ? Number((t.win / decided).toFixed(3)) : null,
      decided,
      unresolved: t.open,
    };
  });
}
/**
 * How often a setup reached a target set at k times the risk, before its stop.
 *
 * Built from the high-water mark of every past trade, so one walk answers the
 * question for every distance at once. A trade that ran to 1.2R and then stopped
 * out is a win for a 1R target and a loss for a 1.5R one, which is exactly how a
 * real sell limit would have behaved.
 *
 * Pooled across the watchlist: this is a fact about how far these setups travel,
 * not about any one company, and pooling turns a dozen trades into a couple of
 * hundred.
 */
const REWARD_MULTIPLES = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5];

function buildRewardCurve(cards) {
  const runs = cards.flatMap((c) => c.backtest?.runs ?? []);
  return REWARD_MULTIPLES.map((multiple) => {
    let win = 0, loss = 0, open = 0;
    for (const run of runs) {
      if (run.maxR >= multiple) win++;
      else if (run.stopped) loss++;
      else open++; // ran out of time without reaching either
    }
    const decided = win + loss;
    return {
      multiple,
      hitRate: decided >= 20 ? Number((win / decided).toFixed(3)) : null,
      decided,
      unresolved: open,
      // What the average trade returns at this target, in multiples of risk.
      expectancyR: decided >= 20
        ? Number(((win / decided) * multiple - (1 - win / decided)).toFixed(3))
        : null,
    };
  });
}

/** Pending sell orders for one holding, matched by the Trading 212 ticker. */
function ordersFor(pos, orders) {
  const mine = orders.filter((o) => o.ticker === pos.t212Ticker && o.side === 'SELL');
  const qty = (list) => list.reduce((sum, o) => sum + Math.abs(o.quantity ?? 0), 0);
  const stops = mine.filter((o) => /STOP/.test(o.type ?? ''));
  const limits = mine.filter((o) => o.type === 'LIMIT');
  if (!mine.length) return { stops: [], limits: [], stopQty: 0, limitQty: 0 };
  return {
    stops: stops.map((o) => ({ price: o.stopPrice, quantity: Math.abs(o.quantity ?? 0), id: o.id })),
    limits: limits.map((o) => ({ price: o.limitPrice, quantity: Math.abs(o.quantity ?? 0), id: o.id })),
    stopQty: Number(qty(stops).toFixed(8)),
    limitQty: Number(qty(limits).toFixed(8)),
  };
}
async function main() {
  const started = Date.now();
  const { tickers, limit } = parseArgs();
  const config = await readJson('config/scoring.config.json');
  const watchlist = await readJson('config/watchlist.json');

  const pick = (list) => {
    let out = list;
    if (tickers) out = out.filter((s) => tickers.includes(s.ticker));
    if (limit) out = out.slice(0, limit);
    return out;
  };

  const longEntries = pick(watchlist.long_term);
  const swingEntries = pick(watchlist.swing_term);

  const totalWeight = Object.values(config.swing.weights).reduce((a, b) => a + b, 0);
  if (totalWeight !== 100) throw new Error(`Swing weights total ${totalWeight}, must be 100`);

  console.log(`\nScanning ${longEntries.length} long-term, ${swingEntries.length} swing-term\n`);

  console.log('Long-term:');
  const longResults = await collect(longEntries, config);
  console.log('\nSwing-term:');
  const swingResults = await collect(swingEntries, config);

  const errors = [...longResults, ...swingResults].filter((r) => r.error).map((r) => r.error);
  const okLong = longResults.filter((r) => !r.error);
  const okSwing = swingResults.filter((r) => !r.error);

  // Valuation yardstick is drawn from every stock we successfully fetched.
  const medians = sectorMedianPE([...okLong, ...okSwing].map((r) => r.data));

  const longTerm = okLong
    .map(({ data, news }) => toCard(data, news,
      scoreLongTermStock(data, news, config, medians[data.fundamentals.sector]), config, medians[data.fundamentals.sector]))
    .sort((a, b) => b.score - a.score);

  const swingTerm = okSwing
    .map(({ data, news }) => toCard(data, news, scoreSwingStock(data, news, config), config, medians[data.fundamentals.sector]))
    .sort((a, b) => b.score - a.score);

  // Portfolio is optional: no key means no portfolio, never a failed scan.
  const t212 = await getT212Credentials();
  const portfolio = await getPortfolio(t212.key, t212.secret);
  const orderBook = await getOrders(t212.key, t212.secret);
  if (portfolio.available) {
    await loadT212Metadata(() => fetchInstruments(t212.key, t212.secret));
    const byTicker = new Map([...longTerm, ...swingTerm].map((s) => [s.ticker, s]));

    // Resolve the real instrument FIRST. Matching on the raw ticker misses
    // holdings whose T212 ticker is historic — AGC_US_EQ is Grab, so matching
    // "AGC" against the watchlist would wrongly report it as not held.
    for (const pos of portfolio.positions) {
      const info = await resolveInstrument(pos.t212Ticker, pos.ticker);
      pos.displayTicker = info.displayTicker ?? pos.ticker;
      pos.fullName = info.name ?? pos.ticker;
      pos.currency = info.currency ?? (/_US_EQ$/.test(pos.t212Ticker ?? '') ? 'USD' : null);
      pos.type = info.type ?? null;
      pos.symbol = info.symbol ?? null;

      if (pos.quantity != null && pos.currentPrice != null) {
        pos.value = Number((pos.quantity * pos.currentPrice).toFixed(2));
        const rate = await getFxRate(pos.currency, portfolio.currency);
        pos.valueAccount = rate == null ? null : Number((pos.value * rate).toFixed(2));
      }

      // Match on the resolved symbol, falling back to the raw ticker.
      const match = byTicker.get(pos.displayTicker) ?? byTicker.get(pos.ticker);
      pos.onWatchlist = Boolean(match);
      pos.score = match?.score ?? null;
      pos.category = match ? (longTerm.includes(match) ? 'Long-term' : 'Swing') : null;
      // Mark the watchlist card too, so a score is read knowing you hold it.
      if (match) match.held = { quantity: pos.quantity, pplPct: pos.pplPct };
      // Where to get out, both ways, for what you actually paid.
      pos.plan = await buildPositionPlan(pos, match);
      // What you have actually told Trading 212 to do, so the dashboard can
      // check it against what it is recommending rather than assume.
      pos.orders = ordersFor(pos, orderBook.orders ?? []);
    }

    // Biggest holdings first: what the money is actually in matters more than
    // which position happens to be up the most.
    portfolio.positions.sort((a, b) => (b.valueAccount ?? b.value ?? 0) - (a.valueAccount ?? a.value ?? 0));

    // Forget plans for anything sold, so the store cannot grow without bound.
    await pruneStops(portfolio.positions);

    portfolio.health = await runHealthCheck(portfolio, watchlist);
    if (portfolio.health) {
      const { flags, notes } = portfolio.health.summary;
      console.log(`  health check: ${flags} flag(s), ${notes} note(s)`);
    }

    const withStops = portfolio.positions.filter((p) => p.orders?.stops.length).length;
    console.log(`  pending orders: ${(orderBook.orders ?? []).length}, ${withStops} position(s) with a stop`);
    console.log(`\nTrading 212 (${portfolio.accountType}): ${portfolio.positions.length} positions, ` +
      `${portfolio.positions.filter((p) => p.onWatchlist).length} on the watchlist`);
  } else {
    console.log(`\nTrading 212: ${portfolio.reason}`);
  }

  const progressCurve = buildProgressCurve(swingTerm);
  const rewardCurve = buildRewardCurve(swingTerm);
  for (const card of swingTerm) { delete card.backtest?.progress; delete card.backtest?.runs; }

  const output = {
    generatedAt: new Date().toISOString(),
    dataAsOf: longTerm[0]?.asOf ?? swingTerm[0]?.asOf ?? null,
    portfolio,
    config: { swingWeights: config.swing.weights, longTermWeights: config.longTerm.weights },
    sectorMedianPE: medians,
    progressCurve,
    rewardCurve,
    longTerm,
    swingTerm,
    errors,
  };

  await mkdir(join(ROOT, 'public/data'), { recursive: true });
  await writeFile(join(ROOT, 'public/data/latest.json'), JSON.stringify(output, null, 2));

  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  ${longTerm.length} long-term, ${swingTerm.length} swing-term, ${errors.length} failed`);
  console.log('  -> public/data/latest.json\n');

  if (errors.length === longEntries.length + swingEntries.length) {
    throw new Error('Every ticker failed, not writing a useful file');
  }
}

main().catch((err) => {
  console.error(`\nScan failed: ${err.message}`);
  process.exit(1);
});
