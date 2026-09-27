import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Pembaca .env lokal untuk e2e Playwright (proses Node — bukan bundle browser).
 * Kredensial QA TIDAK diberi prefix VITE_ sehingga tidak pernah masuk bundle;
 * spec e2e menyuntikkannya ke halaman lewat page.evaluate saat runtime.
 */

export type QaRole = 'alpha' | 'bravo' | 'charlie';

export interface QaUser {
  email: string;
  password: string;
  id: string;
}

function parseEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    values[key] = value;
  }
  return values;
}

const env = parseEnvFile(resolve(process.cwd(), '.env'));

export function qaUser(role: QaRole): QaUser {
  const prefix = `TEST_USER_${role.toUpperCase()}`;
  const email = env[`${prefix}_EMAIL`];
  const password = env[`${prefix}_PASSWORD`];
  const id = env[`${prefix}_ID`];
  if (email === undefined || password === undefined || id === undefined) {
    throw new Error(`QA user ${role} belum lengkap di .env — butuh ${prefix}_EMAIL/_PASSWORD/_ID`);
  }
  return { email, password, id };
}
