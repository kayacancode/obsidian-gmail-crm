// Mint a People session cookie for the LOCAL dev instance only.
// Reads TOKEN_SECRET from .dev.vars (never production) and prints the cookie
// value that public pages send as `__Host-people-session`. Used by demo/record.mjs.
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const b64 = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function localSecret() {
  const text = readFileSync(join(here, '..', '.dev.vars'), 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('TOKEN_SECRET='));
  if (!line) throw new Error('TOKEN_SECRET missing from .dev.vars');
  return line.slice('TOKEN_SECRET='.length).trim();
}

// Mirrors src/session.ts makeSession + src/mail-model.ts opaque('session', value, secret).
export function mintSession(email, secret = localSecret(), ttlMs = 86_400_000) {
  const payload = b64(Buffer.from(JSON.stringify({ email, expires: Date.now() + ttlMs })));
  const mac = b64(createHmac('sha256', secret).update('session\0' + payload).digest());
  return `${payload}.${mac}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const email = process.argv[2];
  if (!email) { console.error('usage: node demo/session.mjs <email>'); process.exit(2); }
  process.stdout.write(mintSession(email) + '\n');
}
