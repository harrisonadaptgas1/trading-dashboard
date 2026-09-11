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
// The published build keeps the tracked name; the local one is gitignored, so
// the two can never overwrite each other or conflict on a pull.
const TARGET_PUBLIC = join(ROOT, 'public/data/site.json');
const TARGET_LOCAL = join(ROOT, 'public/data/site.local.json');

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

  await writeFile(isPublic ? TARGET_PUBLIC : TARGET_LOCAL, JSON.stringify(data));

  // GitHub Pages caches assets for 10 minutes, so after a deploy a browser can
  // pair new HTML with a stale app.js and throw on elements that no longer
  // exist. Stamping the asset URLs makes that impossible.
  //
  // Only on the public build: the local server sends Cache-Control: no-store,
  // so it has no such problem — and stamping locally too meant every local
  // build and every workflow run wrote a different version into index.html,
  // which conflicted on every single pull.
  if (isPublic) {
    const version = Date.parse(data.generatedAt) || Date.now();
    const indexPath = join(ROOT, 'public/index.html');
    const html = (await readFile(indexPath, 'utf8'))
      .replace(/(href="styles\.css)(\?v=\d+)?"/, `$1?v=${version}"`)
      .replace(/(src="app\.js)(\?v=\d+)?"/, `$1?v=${version}"`);
    await writeFile(indexPath, html);
  }
  const kb = (JSON.stringify(data).length / 1024).toFixed(0);
  console.log(isPublic
    ? `Public build written (${kb}KB) — portfolio and holdings removed, verified clean`
    : `Local build written (${kb}KB) — includes your portfolio`);
  console.log('  -> public/data/' + (isPublic ? 'site.json' : 'site.local.json'));
}

main().catch((err) => {
  console.error(`\nPublish failed: ${err.message}`);
  process.exit(1);
});
