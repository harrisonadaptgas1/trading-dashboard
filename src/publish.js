// Turn the raw scan into the file the dashboard reads.
//
//   node src/publish.js            local build - keeps everything
//   node src/publish.js --public   published build - portfolio removed
//
// There is no password and no encryption: the published build carries only
// market data and scores, which are not sensitive. The guard below is what
// keeps it that way — it refuses to write a public build that still contains
// holdings, so the protection is enforced by code rather than by remembering.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'public/data/latest.json');
const TARGET = join(ROOT, 'public/data/site.json');

/** Anything that describes what you own, rather than what the market is doing. */
function stripPersonal(data) {
  delete data.portfolio;
  for (const s of [...(data.longTerm ?? []), ...(data.swingTerm ?? [])]) delete s.held;
  data.publicBuild = true;
  return data;
}

async function main() {
  const isPublic = process.argv.includes('--public') || process.env.PUBLISH_MODE === 'public';
  const data = JSON.parse(await readFile(SOURCE, 'utf8'));

  if (isPublic) stripPersonal(data);

  // Refuse to publish anything personal, whatever the flags said.
  if (isPublic) {
    const serialised = JSON.stringify(data);
    const leaks = [];
    if (data.portfolio !== undefined) leaks.push('portfolio object');
    if ([...(data.longTerm ?? []), ...(data.swingTerm ?? [])].some((s) => s.held)) leaks.push('holding badges');
    if (/"(quantity|averagePrice|valueAccount|ppl)"\s*:/.test(serialised)) leaks.push('position fields');
    if (leaks.length) {
      throw new Error(`Refusing to publish: personal data present (${leaks.join(', ')})`);
    }
  }

  await writeFile(TARGET, JSON.stringify(data));
  const kb = (JSON.stringify(data).length / 1024).toFixed(0);
  console.log(isPublic
    ? `Public build written (${kb}KB) — portfolio and holdings removed, verified clean`
    : `Local build written (${kb}KB) — includes your portfolio`);
  console.log('  -> public/data/site.json');
}

main().catch((err) => {
  console.error(`\nPublish failed: ${err.message}`);
  process.exit(1);
});
