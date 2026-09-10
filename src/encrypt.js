// Encrypt latest.json so the published file is useless without the password.
// GitHub Pages always serves publicly, even from a private repo, so the data
// itself is the thing that has to be protected, not the page around it.
//
//   DASHBOARD_PASSWORD=... node src/encrypt.js
import { readFile, writeFile } from 'node:fs/promises';
import { webcrypto as crypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ITERATIONS = 250_000;

export async function deriveKey(password, salt) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

const b64 = (buf) => Buffer.from(buf).toString('base64');

async function main() {
  const password = process.env.DASHBOARD_PASSWORD?.trim();
  if (!password) throw new Error('DASHBOARD_PASSWORD is not set');
  if (password.length < 10) throw new Error('Use a password of at least 10 characters');

  let plaintext = await readFile(join(ROOT, 'public/data/latest.json'), 'utf8');

  // The published build goes to a public repository and may be shared, so it
  // carries the watchlist and scores only. Holdings, balances and anything
  // derived from them never leave this machine.
  const publicBuild = process.argv.includes('--public') || process.env.PUBLISH_MODE === 'public';
  if (publicBuild) {
    const data = JSON.parse(plaintext);
    delete data.portfolio;
    for (const s of [...(data.longTerm ?? []), ...(data.swingTerm ?? [])]) delete s.held;
    data.publicBuild = true;
    plaintext = JSON.stringify(data);
    console.log('Public build: portfolio, balances and holding badges removed');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)
  );

  const parsed = JSON.parse(plaintext);
  await writeFile(join(ROOT, 'public/data/latest.enc.json'), JSON.stringify({
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS },
    salt: b64(salt),
    iv: b64(iv),
    ciphertext: b64(ciphertext),
    // Safe to leave in the clear so the login screen can show freshness.
    generatedAt: parsed.generatedAt,
  }));

  const kb = (ciphertext.byteLength / 1024).toFixed(0);
  console.log(`Encrypted ${(plaintext.length / 1024).toFixed(0)}KB -> ${kb}KB ciphertext`);
  console.log('  -> public/data/latest.enc.json');
}

main().catch((err) => {
  console.error(`Encrypt failed: ${err.message}`);
  process.exit(1);
});
