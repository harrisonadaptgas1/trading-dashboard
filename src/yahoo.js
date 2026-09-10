// Price history + fundamentals from Yahoo Finance (free, no API key).
import YahooFinance from 'yahoo-finance2';

export const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FUNDAMENTAL_MODULES = [
  'price', 'summaryDetail', 'defaultKeyStatistics',
  'financialData', 'calendarEvents', 'assetProfile',
];

/**
 * Two years of daily bars: enough for a 200-day average plus a month of slope.
 */
async function getHistory(ticker) {
  const period1 = new Date();
  period1.setFullYear(period1.getFullYear() - 2);

  const chart = await yf.chart(ticker, { period1, interval: '1d' });
  const rows = (chart.quotes ?? []).filter(
    (q) => q.close != null && q.high != null && q.low != null && q.volume != null
  );
  if (rows.length < 30) throw new Error(`only ${rows.length} usable price bars`);

  return {
    dates: rows.map((r) => new Date(r.date).toISOString().slice(0, 10)),
    closes: rows.map((r) => r.close),
    highs: rows.map((r) => r.high),
    lows: rows.map((r) => r.low),
    volumes: rows.map((r) => r.volume),
  };
}

/** Fundamentals, with every field optional. Anything missing is skipped, not fatal. */
async function getFundamentals(ticker) {
  try {
    const qs = await yf.quoteSummary(ticker, { modules: FUNDAMENTAL_MODULES });
    const earningsDates = qs.calendarEvents?.earnings?.earningsDate ?? [];
    return {
      currency: qs.price?.currency ?? 'USD',
      marketCap: qs.price?.marketCap ?? qs.summaryDetail?.marketCap ?? null,
      sector: qs.assetProfile?.sector ?? null,
      trailingPE: qs.summaryDetail?.trailingPE ?? null,
      forwardPE: qs.summaryDetail?.forwardPE ?? null,
      earningsGrowth: qs.financialData?.earningsGrowth ?? null,
      earningsQuarterlyGrowth: qs.defaultKeyStatistics?.earningsQuarterlyGrowth ?? null,
      revenueGrowth: qs.financialData?.revenueGrowth ?? null,
      earningsDate: earningsDates.length ? new Date(earningsDates[0]).toISOString() : null,
    };
  } catch (err) {
    console.warn(`  ! Fundamentals unavailable for ${ticker}: ${err.message}`);
    return { currency: 'USD', sector: null, trailingPE: null, forwardPE: null,
             earningsGrowth: null, revenueGrowth: null, earningsDate: null, marketCap: null };
  }
}

export async function getStockData({ ticker, name }) {
  const [series, fundamentals] = await Promise.all([getHistory(ticker), getFundamentals(ticker)]);
  const closes = series.closes;
  const price = closes[closes.length - 1];
  const prev = closes[closes.length - 2] ?? price;

  return {
    ticker,
    name,
    price,
    changePct: prev ? ((price - prev) / prev) * 100 : 0,
    asOf: series.dates[series.dates.length - 1],
    series,
    fundamentals,
  };
}

/** Run tasks with limited concurrency and a small delay, to stay polite to Yahoo. */
export async function mapWithLimit(items, limit, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    results.push(...await Promise.all(batch.map(fn)));
    if (i + limit < items.length) await sleep(300);
  }
  return results;
}
