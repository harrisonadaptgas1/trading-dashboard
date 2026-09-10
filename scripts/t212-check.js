// Diagnostic for the Trading 212 connection.
//
// Prints the SHAPE of the response only - field names, types, counts. It never
// prints holdings, prices, quantities or balances, so the output is safe to share
// when something needs debugging.
//
//   node scripts/t212-check.js
import { getPortfolio } from '../src/trading212.js';
import { getT212Credentials } from '../src/secrets.js';

/** Describe a value by type, never by content. */
function shape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') {
    // Dates and currency codes are safe and useful; everything else is masked.
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'string(date)';
    if (/^[A-Z]{3}$/.test(value)) return `string("${value}")`;
    return `string(len ${value.length})`;
  }
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function describe(obj, indent = '  ') {
  for (const [k, v] of Object.entries(obj ?? {})) {
    console.log(`${indent}${k}: ${shape(v)}`);
  }
}

const { key, secret } = await getT212Credentials();

console.log('\nTrading 212 connection check');
console.log('----------------------------');
console.log(`API key present:    ${key ? `yes (${key.length} characters)` : 'NO'}`);
console.log(`API secret present: ${secret ? `yes (${secret.length} characters)` : 'NO'}`);

// Note: process.exit() here would trip a libuv assertion on Windows, because
// fetch's sockets are still closing. Setting exitCode lets Node drain first.
const result = key ? await getPortfolio(key, secret) : null;

if (!key) {
  console.log('\nSet T212_API_KEY in start-dashboard.bat, then run this again.\n');
  process.exitCode = 1;
} else if (!result.available) {
  console.log(`\nFAILED: ${result.reason}\n`);
  process.exitCode = 1;
} else {
  report(result);
}

function report(result) {
console.log(`Account type:    ${result.accountType}`);
console.log(`Account currency: ${result.currency ?? 'unknown'}`);
console.log(`Positions found: ${result.positions.length}`);

if (result.positions.length) {
  console.log('\nFields on each position:');
  describe(result.positions[0]);
  const missing = Object.entries(result.positions[0])
    .filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length) console.log(`\n  Came back empty: ${missing.join(', ')}`);

  const withPie = result.positions.filter((p) => p.pieQuantity).length;
  console.log(`\nPositions partly inside a Pie: ${withPie} of ${result.positions.length}`);
  // Tickers are needed to check watchlist matching, and are not sensitive.
  console.log(`Tickers: ${result.positions.map((p) => p.ticker).join(', ')}`);
}

console.log('\nAccount cash fields:');
if (result.cashError) console.log(`  unavailable: ${result.cashError}`);
else describe(result.cash);

console.log('\nOK - the connection works.\n');
}
