// Local-only secret storage for the Trading 212 credentials.
//
// Written to secrets.local.json next to the project and gitignored, so it never
// reaches GitHub. Read server-side only; never sent to the browser and never
// written into the scan output.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'secrets.local.json');

export async function readSecrets() {
  try {
    return JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Environment variables win, so start-dashboard.bat still works if you prefer it. */
export async function getT212Credentials() {
  const stored = await readSecrets();
  return {
    key: process.env.T212_API_KEY?.trim() || stored.t212Key || null,
    secret: process.env.T212_API_SECRET?.trim() || stored.t212Secret || null,
    fromEnv: Boolean(process.env.T212_API_KEY?.trim()),
  };
}

export async function setT212Credentials(key, secret) {
  const secrets = await readSecrets();
  secrets.t212Key = key.trim();
  if (secret?.trim()) secrets.t212Secret = secret.trim();
  else delete secrets.t212Secret;
  await writeFile(FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

export async function clearT212Credentials() {
  const secrets = await readSecrets();
  delete secrets.t212Key;
  delete secrets.t212Secret;
  if (Object.keys(secrets).length) await writeFile(FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  else await unlink(FILE).catch(() => {});
}
