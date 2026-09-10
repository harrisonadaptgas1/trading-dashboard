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
import { scoreSwingStock } from './scoreSwing.js';
import { scoreLongTermStock } from './scoreLongTerm.js';

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

function toCard(data, news, scored, config) {
  const n = config.chart.sparklineDays;
  return {
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
      scoreLongTermStock(data, news, config, medians[data.fundamentals.sector]), config))
    .sort((a, b) => b.score - a.score);

  const swingTerm = okSwing
    .map(({ data, news }) => toCard(data, news, scoreSwingStock(data, news, config), config))
    .sort((a, b) => b.score - a.score);

  const output = {
    generatedAt: new Date().toISOString(),
    dataAsOf: longTerm[0]?.asOf ?? swingTerm[0]?.asOf ?? null,
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
