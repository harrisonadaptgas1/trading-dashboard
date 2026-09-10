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
import { getPortfolio, fetchInstruments } from './trading212.js';
import { getT212Credentials } from './secrets.js';
import { resolveInstrument, getFxRate, loadT212Metadata } from './instruments.js';
import { assessRisk, buildChecklist } from './risk.js';
import { runBacktest } from './backtest.js';
import { buildAnalystView } from './analysts.js';
import { runHealthCheck } from './healthCheck.js';

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
    analysts,
    ticker: data.ticker,
    name: data.name,
    price: Number(data.price.toFixed(2)),
    currency: data.fundamentals.currency,
    changePct: Number(data.changePct.toFixed(2)),
    asOf: data.asOf,
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
    }

    // Biggest holdings first: what the money is actually in matters more than
    // which position happens to be up the most.
    portfolio.positions.sort((a, b) => (b.valueAccount ?? b.value ?? 0) - (a.valueAccount ?? a.value ?? 0));

    portfolio.health = await runHealthCheck(portfolio, watchlist);
    if (portfolio.health) {
      const { flags, notes } = portfolio.health.summary;
      console.log(`  health check: ${flags} flag(s), ${notes} note(s)`);
    }

    console.log(`\nTrading 212 (${portfolio.accountType}): ${portfolio.positions.length} positions, ` +
      `${portfolio.positions.filter((p) => p.onWatchlist).length} on the watchlist`);
  } else {
    console.log(`\nTrading 212: ${portfolio.reason}`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    dataAsOf: longTerm[0]?.asOf ?? swingTerm[0]?.asOf ?? null,
    portfolio,
    config: { swingWeights: config.swing.weights, longTermWeights: config.longTerm.weights },
    sectorMedianPE: medians,
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
