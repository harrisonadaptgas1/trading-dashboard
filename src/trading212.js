// Trading 212 public API (beta). Runs server-side only: the API key never reaches
// the browser. Every failure is soft — if this cannot fetch, the dashboard simply
// shows no portfolio rather than the whole scan dying.
//
// Needs a READ-ONLY key: portfolio + account scopes. Never grant "orders".

const HOSTS = {
  live: 'https://live.trading212.com',
  demo: 'https://demo.trading212.com',
};

const TIMEOUT_MS = 15000;

/**
 * Trading 212 uses HTTP Basic auth: base64("API_KEY:API_SECRET").
 * Older single-value keys were sent raw in the Authorization header, so when no
 * secret is supplied we fall back to that rather than failing outright.
 */
export function authHeader(key, secret) {
  return secret
    ? `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`
    : key;
}

async function call(host, path, auth) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${host}/api/v0${path}`, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error(`rejected (${res.status})`), { auth: true });
    }
    if (res.status === 429) {
      throw new Error('Rate limited by Trading 212. Wait a minute and scan again.');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Some accounts expose /info, others /summary, so try both before giving up.
const INFO_PATHS = ['/equity/account/info', '/equity/account/summary'];

/** A key belongs to either the live or the practice account, so try both. */
async function resolveHost(auth) {
  const errors = [];
  for (const [name, host] of Object.entries(HOSTS)) {
    for (const path of INFO_PATHS) {
      try {
        const info = await call(host, path, auth);
        return { name, host, info };
      } catch (err) {
        errors.push(`${name}${path}: ${err.message}`);
        // A 401/403 means the credentials are wrong everywhere, not just here,
        // so stop hammering the other endpoints for this host.
        if (err.auth) break;
      }
    }
  }
  throw new Error([...new Set(errors)].join(' | '));
}

/** The full instrument list: authoritative names for every tradable ticker. */
export async function fetchInstruments(key, secret, host = HOSTS.live) {
  return call(host, '/equity/metadata/instruments', authHeader(key, secret));
}

/** "AAPL_US_EQ" -> "AAPL" so holdings can be matched to watchlist entries. */
export function baseTicker(t212Ticker = '') {
  return String(t212Ticker).split('_')[0].toUpperCase();
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Fetch positions plus account cash. Returns a shape the dashboard can render,
 * with `available: false` and a plain-English reason when anything goes wrong.
 */
export async function getPortfolio(key, secret) {
  if (!key) {
    return { available: false, reason: 'No Trading 212 API key set, so the portfolio is turned off.' };
  }

  const auth = authHeader(key, secret);

  let resolved;
  try {
    resolved = await resolveHost(auth);
  } catch (err) {
    const rejected = /rejected \(40[13]\)/.test(err.message);
    return {
      available: false,
      reason: rejected
        ? (secret
            ? 'Trading 212 rejected those credentials. Check the key and secret are both correct, that the key has portfolio and account permissions, and that any IP restriction matches this computer.'
            : 'Trading 212 rejected that key. Newer keys need the API Secret as well — add it and try again.')
        : `Could not reach Trading 212. ${err.message}`,
    };
  }

  const { host, name: accountType, info } = resolved;

  const [positions, cash] = await Promise.all([
    call(host, '/equity/portfolio', auth).catch((e) => ({ __error: e.message })),
    call(host, '/equity/account/cash', auth).catch((e) => ({ __error: e.message })),
  ]);

  if (positions?.__error) {
    return { available: false, reason: `Could not read your positions. ${positions.__error}` };
  }

  const rows = (Array.isArray(positions) ? positions : []).map((p) => {
    const quantity = num(p.quantity);
    const averagePrice = num(p.averagePrice);
    const currentPrice = num(p.currentPrice);
    const ppl = num(p.ppl);
    // Percentage return on this position, from cost basis rather than the P&L
    // figure, which is in account currency and may include an FX component.
    const pplPct = averagePrice && currentPrice
      ? ((currentPrice - averagePrice) / averagePrice) * 100
      : null;

    return {
      t212Ticker: p.ticker ?? null,
      ticker: baseTicker(p.ticker),
      quantity,
      averagePrice,
      currentPrice,
      ppl,
      fxPpl: num(p.fxPpl),
      pplPct: pplPct == null ? null : Number(pplPct.toFixed(2)),
      // When you first bought this holding. The value chart must not run
      // earlier than this, or it shows gains on shares you did not own.
      initialFillDate: p.initialFillDate ? new Date(p.initialFillDate).toISOString() : null,
      // Non-zero means some or all of this holding sits inside a Pie.
      pieQuantity: num(p.pieQuantity),
    };
  });

  return {
    available: true,
    accountType,                       // "live" or "demo"
    currency: info?.currencyCode ?? null,
    fetchedAt: new Date().toISOString(),
    positions: rows,
    cash: cash?.__error ? null : {
      free: num(cash?.free),
      invested: num(cash?.invested),
      total: num(cash?.total),
      ppl: num(cash?.ppl),
      result: num(cash?.result),
    },
    cashError: cash?.__error ?? null,
  };
}

/**
 * Pending orders, so the dashboard can check that what you have actually set
 * matches what you think you have set. Read-only, like everything else here:
 * the key has no order permissions and nothing is ever placed or cancelled.
 */
export async function getOrders(key, secret) {
  const auth = authHeader(key, secret);
  for (const [type, host] of Object.entries(HOSTS)) {
    try {
      const rows = await call(host, '/equity/orders', auth);
      if (Array.isArray(rows)) return { available: true, accountType: type, orders: rows };
    } catch (err) {
      if (err.auth) continue; // wrong environment for this key, try the other
    }
  }
  return { available: false, orders: [] };
}
