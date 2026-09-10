// Resolve a Trading 212 instrument to its real Yahoo symbol, company name and
// currency, so the portfolio can show "VUAG · Vanguard S&P 500 UCITS ETF" rather
// than the raw "VUAGL" that T212's internal ticker decodes to.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { yf } from './yahoo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const META_FILE = join(ROOT, 'cache', 't212-instruments.json');
const META_MAX_AGE_DAYS = 7;

const cache = new Map();
const fxCache = new Map();
let metadata = null;

/**
 * Trading 212's own instrument list is the authoritative source for what a
 * holding actually is. Its internal tickers can be badly out of date — Grab is
 * listed under AGC_US_EQ, the SPAC that merged with it in 2021 — so guessing the
 * real symbol from the ticker string gets the wrong company.
 *
 * The list is 17k+ entries and rate-limited, so it is cached on disk for a week.
 */
export async function loadT212Metadata(fetchList) {
  if (metadata) return metadata;

  try {
    const raw = JSON.parse(await readFile(META_FILE, 'utf8'));
    const ageDays = (Date.now() - new Date(raw.fetchedAt).getTime()) / 86400000;
    if (ageDays < META_MAX_AGE_DAYS && raw.instruments) {
      metadata = new Map(Object.entries(raw.instruments));
      return metadata;
    }
  } catch { /* no usable cache, fetch below */ }

  if (!fetchList) return null;
  try {
    const list = await fetchList();
    const byTicker = Object.fromEntries(list.map((i) => [i.ticker, {
      name: i.name, shortName: i.shortName, currency: i.currencyCode, type: i.type, isin: i.isin,
    }]));
    await mkdir(dirname(META_FILE), { recursive: true });
    await writeFile(META_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), instruments: byTicker }));
    metadata = new Map(Object.entries(byTicker));
    console.log(`  cached ${list.length} Trading 212 instrument names`);
    return metadata;
  } catch (err) {
    console.warn(`  ! Could not load Trading 212 instrument names: ${err.message}`);
    return null;
  }
}

export const lookupT212 = (ticker) => metadata?.get(ticker) ?? null;

/**
 * T212 encodes the exchange as a lowercase letter before "_EQ" ("VUAGl_EQ" is
 * VUAG on the LSE); US listings use "_US_EQ". Try the plausible Yahoo symbols
 * and keep whichever resolves.
 */
export function candidateSymbols(t212Ticker, base) {
  if (!t212Ticker) return base ? [base] : [];
  const body = t212Ticker.replace(/_EQ$/, '');
  if (/_US$/.test(body)) return [body.replace(/_US$/, '')];

  const m = body.match(/^(.*?)([a-z])$/);
  const SUFFIX = { l: '.L', d: '.DE', a: '.AS', p: '.PA', m: '.MI', s: '.SW', e: '.MC' };
  if (m) {
    const [, root, code] = m;
    return [...(SUFFIX[code] ? [root + SUFFIX[code]] : []), `${root}.L`, root];
  }
  return [body];
}

// LSE prices often come back in pence under the currency code "GBp".
const normaliseCcy = (c) => (c === 'GBp' ? 'GBP' : c);

/**
 * Look up name and currency. Returns nulls rather than throwing when Yahoo has
 * no record of the instrument, which happens for some smaller US listings.
 */
export async function resolveInstrument(t212Ticker, base) {
  const key = t212Ticker ?? base;
  if (cache.has(key)) return cache.get(key);

  // Trading 212's own record wins for the NAME: it knows AGC_US_EQ is Grab.
  // But its short name is not always a valid Yahoo symbol — VUAG is listed on
  // Yahoo as VUAG.L — so the lookup symbol is still resolved separately.
  const meta = lookupT212(t212Ticker);

  let result = { symbol: null, name: null, currency: null };
  // Try the T212 short name first — for US stocks it is usually the Yahoo
  // symbol too — then the ticker-derived candidates.
  const candidates = [...new Set([
    ...(meta?.shortName ? [meta.shortName] : []),
    ...candidateSymbols(t212Ticker, base),
  ])];

  for (const symbol of candidates) {
    try {
      const q = await yf.quote(symbol);
      if (q?.regularMarketPrice != null || q?.longName || q?.shortName) {
        result = {
          symbol,
          // Strip the exchange suffix for display: "VUAG.L" reads as "VUAG".
          displayTicker: symbol.replace(/\.[A-Z]+$/, ''),
          name: q.longName ?? q.shortName ?? null,
          currency: normaliseCcy(q.currency ?? 'USD'),
        };
        break;
      }
    } catch { /* try the next candidate */ }
  }

  // Trading 212's name and type are authoritative; Yahoo supplies the symbol.
  if (meta) {
    result.displayTicker = meta.shortName ?? result.displayTicker;
    result.name = meta.name ?? result.name;
    result.currency = normaliseCcy(meta.currency ?? result.currency ?? 'USD');
    result.type = meta.type ?? null;
    result.symbol ??= meta.shortName;
  }

  cache.set(key, result);
  return result;
}

/** Spot FX rate, e.g. USD -> GBP. Returns 1 when the currencies match. */
export async function getFxRate(from, to) {
  if (!from || !to || from === to) return 1;
  const key = `${from}${to}`;
  if (fxCache.has(key)) return fxCache.get(key);
  try {
    const q = await yf.quote(`${key}=X`);
    const rate = q?.regularMarketPrice ?? null;
    fxCache.set(key, rate);
    return rate;
  } catch {
    fxCache.set(key, null);
    return null;
  }
}
