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
      industry: qs.assetProfile?.industry ?? null,
      trailingPE: qs.summaryDetail?.trailingPE ?? null,
      forwardPE: qs.summaryDetail?.forwardPE ?? null,
      earningsGrowth: qs.financialData?.earningsGrowth ?? null,
      earningsQuarterlyGrowth: qs.defaultKeyStatistics?.earningsQuarterlyGrowth ?? null,
      revenueGrowth: qs.financialData?.revenueGrowth ?? null,
      earningsDate: earningsDates.length ? new Date(earningsDates[0]).toISOString() : null,
      targetMeanPrice: qs.financialData?.targetMeanPrice ?? null,
      targetLowPrice: qs.financialData?.targetLowPrice ?? null,
      targetHighPrice: qs.financialData?.targetHighPrice ?? null,
      numberOfAnalystOpinions: qs.financialData?.numberOfAnalystOpinions ?? null,
      recommendationKey: qs.financialData?.recommendationKey ?? null,
    };
  } catch (err) {
    console.warn(`  ! Fundamentals unavailable for ${ticker}: ${err.message}`);
    return { currency: 'USD', sector: null, industry: null, trailingPE: null, forwardPE: null,
             earningsGrowth: null, revenueGrowth: null, earningsDate: null, marketCap: null };
  }
}

/**
 * The price right now, which outside 14:30-21:00 UK is not the last daily close.
 *
 * Yahoo reports pre-market and after-hours prints as separate fields, so before
 * the open the daily bar still says yesterday. A scan run at 14:25 that quotes
 * yesterday's close is worse than useless when you are about to trade at 14:30.
 *
 * Pre- and post-market prints come from thin trading and can be a long way from
 * where the stock actually opens, so the source is carried through and shown.
 */
async function getLivePrice(ticker) {
  try {
    const q = await yf.quote(ticker);
    const state = q.marketState ?? null;
    const ms = (t) => (t == null ? 0 : new Date(t).getTime());

    // Do not switch on the session name. Yahoo has more of them than the obvious
    // three — PREPRE is the early hours before pre-market proper opens, and on a
    // Monday morning it carries no pre-market price at all while still holding
    // Friday evening's after-hours print. Matching only PRE and POST dropped
    // through to the regular close and quietly served a stale price with no
    // label on it. So gather every print on offer and take the most recent.
    const candidates = [
      { price: q.preMarketPrice, at: q.preMarketTime, source: 'pre' },
      { price: q.postMarketPrice, at: q.postMarketTime, source: 'post' },
      {
        price: q.regularMarketPrice,
        at: q.regularMarketTime,
        source: state === 'REGULAR' ? 'live' : 'close',
      },
    ].filter((c) => c.price != null);

    if (!candidates.length) return null;
    const newest = candidates.reduce((best, c) => (ms(c.at) > ms(best.at) ? c : best));

    return {
      price: newest.price,
      source: newest.source,
      at: newest.at ?? null,
      state,
      // What to measure the change against: the regular close for an out-of-hours
      // print, the previous close while the market is actually open.
      reference: newest.source === 'live' || newest.source === 'close'
        ? q.regularMarketPreviousClose ?? null
        : q.regularMarketPrice ?? null,
    };
  } catch (err) {
    console.warn(`  ! Live price unavailable for ${ticker}: ${err.message}`);
  }
  return null;
}
export async function getStockData({ ticker, name }) {
  const [series, fundamentals, live] = await Promise.all([
    getHistory(ticker), getFundamentals(ticker), getLivePrice(ticker),
  ]);
  const closes = series.closes;
  const lastClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2] ?? lastClose;

  // The live print wins when there is one. The daily bars are left untouched:
  // the moving averages, RSI and the entry zone are built from completed
  // sessions, and a thin pre-market print has no business rewriting a 20-day
  // average. It moves where the price sits relative to those levels, not the
  // levels themselves.
  const useLive = live?.price != null && live.source !== 'close';
  const price = useLive ? live.price : lastClose;
  const against = useLive ? (live.reference ?? lastClose) : prevClose;

  return {
    ticker,
    name,
    price,
    changePct: against ? ((price - against) / against) * 100 : 0,
    asOf: series.dates[series.dates.length - 1],
    live: live ? { ...live, used: useLive } : null,
    lastClose,
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
