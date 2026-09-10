// Portfolio health check.
//
// Every check reports a measurable fact about what you hold. Where a widely
// cited convention exists it is named as such, but nothing here tells you what
// to do — the checks describe the portfolio, they do not prescribe one.
import { yf } from './yahoo.js';

/** Top holdings and sector split for an ETF, so we can see through the wrapper. */
async function etfComposition(symbol) {
  try {
    const qs = await yf.quoteSummary(symbol, { modules: ['topHoldings'] });
    const th = qs.topHoldings;
    if (!th) return null;
    return {
      holdings: (th.holdings ?? []).map((h) => ({
        ticker: h.symbol, name: h.holdingName, weight: h.holdingPercent,
      })),
      sectors: (th.sectorWeightings ?? []).map((s) => {
        const [key, weight] = Object.entries(s)[0];
        return { sector: key.replace(/_/g, ' '), weight };
      }),
    };
  } catch {
    return null;
  }
}

const pct = (part, whole) => (whole ? (part / whole) * 100 : 0);
const gbp = (v) => `£${v.toFixed(2)}`;

export async function runHealthCheck(portfolio, watchlist) {
  if (!portfolio?.available || !portfolio.positions.length) return null;

  const positions = portfolio.positions;
  const totalHoldings = positions.reduce((s, p) => s + (p.valueAccount ?? 0), 0);
  const cash = portfolio.cash?.free ?? 0;
  const totalAccount = totalHoldings + cash;
  const checks = [];

  /* --- 1. Concentration ------------------------------------------------- */
  const biggest = [...positions].sort((a, b) => (b.valueAccount ?? 0) - (a.valueAccount ?? 0))[0];
  const biggestPct = pct(biggest.valueAccount ?? 0, totalHoldings);
  checks.push({
    id: 'concentration',
    label: 'Concentration',
    status: biggestPct > 80 ? 'flag' : biggestPct > 50 ? 'note' : 'ok',
    headline: `${biggest.displayTicker} is ${biggestPct.toFixed(0)}% of your holdings`,
    detail: positions.length === 1
      ? 'You hold a single position, so its fortunes are your portfolio’s fortunes.'
      : `You hold ${positions.length} positions. The commonly cited guideline is that no single
         holding dominates, though a broad index fund is usually treated differently from a
         single company, because it is already spread across hundreds of them.`,
  });

  /* --- 2. Look-through: what you own inside your funds ------------------- */
  const lookThrough = [];
  for (const p of positions) {
    if (p.type !== 'ETF' && !/ETF|Vanguard|iShares|S&P/i.test(p.fullName ?? '')) continue;
    const comp = await etfComposition(p.symbol ?? p.displayTicker);
    if (!comp) continue;
    for (const h of comp.holdings) {
      lookThrough.push({
        ticker: h.ticker,
        name: h.name,
        via: p.displayTicker,
        weight: h.weight,
        value: Number(((p.valueAccount ?? 0) * h.weight).toFixed(2)),
      });
    }
    p.sectors = comp.sectors;
  }
  lookThrough.sort((a, b) => b.value - a.value);

  /* --- 3. Watchlist stocks you already own through a fund ---------------- */
  const watchTickers = new Set([
    ...(watchlist.long_term ?? []), ...(watchlist.swing_term ?? []),
  ].map((s) => s.ticker));
  const alreadyOwned = lookThrough.filter((h) => watchTickers.has(h.ticker));

  if (alreadyOwned.length) {
    const total = alreadyOwned.reduce((s, h) => s + h.value, 0);
    checks.push({
      id: 'overlap',
      label: 'Hidden overlap',
      status: 'note',
      headline: `You already own ${alreadyOwned.length} of your watchlist stocks inside ${alreadyOwned[0].via}`,
      detail: `${alreadyOwned.map((h) => `${h.ticker} ${(h.weight * 100).toFixed(1)}%`).join(', ')}
        — about ${gbp(total)} of your ${gbp(totalHoldings)}. Buying any of them directly adds to an
        exposure you already have, rather than starting a new one.`,
      rows: alreadyOwned.map((h) => ({
        label: `${h.ticker} · ${h.name}`,
        value: `${gbp(h.value)} via ${h.via}`,
      })),
    });
  }

  /* --- 4. Single companies above the usual 5% marker --------------------- */
  const singles = positions.filter((p) => p.type !== 'ETF');
  const oversized = singles.filter((p) => pct(p.valueAccount ?? 0, totalHoldings) > 5);
  checks.push({
    id: 'single-stock-size',
    label: 'Individual company sizing',
    status: oversized.length ? 'note' : 'ok',
    headline: oversized.length
      ? `${oversized.length} individual ${oversized.length === 1 ? 'company is' : 'companies are'} above 5% of holdings`
      : singles.length
        ? `All ${singles.length} individual ${singles.length === 1 ? 'company sits' : 'companies sit'} under 5% of holdings`
        : 'You hold no individual companies, only funds',
    detail: 'A frequently cited rule of thumb caps any single company at around 5% of a portfolio, '
      + 'on the basis that any one company can go to zero.',
  });

  /* --- 5. Currency exposure --------------------------------------------- */
  const byCurrency = {};
  for (const p of positions) {
    byCurrency[p.currency ?? 'unknown'] = (byCurrency[p.currency ?? 'unknown'] ?? 0) + (p.valueAccount ?? 0);
  }
  const currencyRows = Object.entries(byCurrency)
    .sort((a, b) => b[1] - a[1])
    .map(([c, v]) => ({ label: c, value: `${gbp(v)} · ${pct(v, totalHoldings).toFixed(0)}%` }));
  checks.push({
    id: 'currency',
    label: 'Currency',
    status: 'ok',
    headline: currencyRows.length === 1
      ? `Everything is priced in ${currencyRows[0].label}`
      : `Split across ${currencyRows.length} currencies`,
    detail: 'A fund priced in pounds can still hold assets in another currency, so the currency '
      + 'a holding trades in is not always the currency you are exposed to.',
    rows: currencyRows,
  });

  /* --- 6. Cash ----------------------------------------------------------- */
  const cashPct = pct(cash, totalAccount);
  checks.push({
    id: 'cash',
    label: 'Cash',
    status: cashPct > 25 ? 'note' : 'ok',
    headline: `${gbp(cash)} uninvested, ${cashPct.toFixed(0)}% of the account`,
    detail: cashPct > 25
      ? 'A large cash balance earns nothing inside a trading account.'
      : 'Most of the account is invested.',
  });

  /* --- 7. Holdings nothing is watching ----------------------------------- */
  const untracked = positions.filter((p) => !p.onWatchlist);
  checks.push({
    id: 'coverage',
    label: 'Monitoring',
    status: untracked.length ? 'note' : 'ok',
    headline: untracked.length
      ? `${untracked.length} of ${positions.length} holdings are not on your watchlist`
      : 'Every holding is on your watchlist',
    detail: untracked.length
      ? `${untracked.map((p) => p.displayTicker).join(', ')} — these get no score, no news and no
         alerts from this dashboard. Adding them to the watchlist would change that.`
      : 'Each holding is scored and news-checked on every scan.',
  });

  const flags = checks.filter((c) => c.status === 'flag').length;
  const notes = checks.filter((c) => c.status === 'note').length;

  return {
    generatedAt: new Date().toISOString(),
    totalHoldings: Number(totalHoldings.toFixed(2)),
    totalAccount: Number(totalAccount.toFixed(2)),
    checks,
    lookThrough: lookThrough.slice(0, 10),
    summary: { flags, notes, ok: checks.length - flags - notes },
  };
}
