// Remembers the exit plan for a holding, so it stops moving once you own it.
//
// The stop loss is recomputed from the latest bars on every scan. For a stock
// you are only watching that is correct — it is a current reading of where the
// setup breaks. For a stock you have already bought it is actively dangerous:
// the level drifts with each new bar, and a stop that keeps sliding away is one
// that never gets hit. You would ride a loss the whole way down while the
// dashboard quietly moved the goalposts.
//
// So the first time a position appears, its stop is frozen and written here.
// After that the dashboard reports the level you actually bought into.
//
// Keyed on the fill date as well as the ticker: sell out and buy back in later
// and that is a new position with a new plan, not the old one resumed.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'cache/position-plans.json');

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(STORE, 'utf8'));
  } catch {
    cache = {}; // no file yet, or it is unreadable: start fresh rather than fail a scan
  }
  return cache;
}

const keyFor = (pos) =>
  `${pos.displayTicker ?? pos.ticker}@${pos.initialFillDate ?? 'unknown'}`;

/**
 * The frozen stop for a position, setting it on first sight.
 * @returns {{stopLoss:number, setAt:string, frozen:boolean}|null}
 */
export async function rememberStop(pos, stopLoss) {
  if (stopLoss == null) return null;
  const store = await load();
  const key = keyFor(pos);

  if (store[key]?.stopLoss != null) {
    return { ...store[key], frozen: true };
  }

  store[key] = { stopLoss: Number(stopLoss.toFixed(2)), setAt: new Date().toISOString() };
  await mkdir(dirname(STORE), { recursive: true });
  await writeFile(STORE, JSON.stringify(store, null, 2));
  return { ...store[key], frozen: false };
}

/** Drop plans for positions that are no longer held, so the file cannot grow forever. */
export async function pruneStops(positions) {
  const store = await load();
  const live = new Set(positions.map(keyFor));
  let removed = 0;
  for (const key of Object.keys(store)) {
    if (!live.has(key)) { delete store[key]; removed++; }
  }
  if (removed) {
    await mkdir(dirname(STORE), { recursive: true });
    await writeFile(STORE, JSON.stringify(store, null, 2));
  }
  return removed;
}
