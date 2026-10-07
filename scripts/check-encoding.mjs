/**
 * Fails the build if any source file contains mojibake.
 *
 * Mojibake is UTF-8 that was decoded as cp1252 or latin-1 and written back out.
 * It is invisible in a diff, passes `tsc`, `eslint` and the test suite, and
 * ships directly to users: "Updatingâ€¦" and "8.4â˜… Â·" are what a browser
 * actually renders.
 *
 * This exists because thirteen files in this repository had it, including
 * user-visible strings, and nothing in the toolchain noticed.
 *
 * `scripts/fix-mojibake.mjs` repairs them. This script only reports.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();

/**
 * The signature of a mis-decode. 'Â', 'Ã', 'â' and 'ð' never appear in a
 * legitimate string in this codebase — they are the leading byte of a cp1252 or
 * latin-1 round trip.
 */
const MOJIBAKE = /[\u00C2\u00C3\u00E2\u00E3\u00F0]|\u0080-\u009F/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (['.ts', '.tsx', '.md', '.sql', '.json', '.css'].includes(extname(full))) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'scripts')),
  ...walk(join(ROOT, 'supabase')),
];

const offenders = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (!MOJIBAKE.test(text)) continue;

  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (MOJIBAKE.test(line)) {
      offenders.push({
        file: file.slice(ROOT.length + 1),
        line: i + 1,
        // Show the code points rather than the glyphs, so the console — which
        // may itself be mis-encoded — cannot hide what is actually wrong.
        detail: [...line]
          .filter((c) => MOJIBAKE.test(c))
          .map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
          .join(' '),
      });
    }
  });
}

if (offenders.length > 0) {
  console.error(`\nMojibake found in ${offenders.length} line(s):\n`);
  for (const o of offenders.slice(0, 40)) {
    console.error(`  ${o.file}:${o.line}  ${o.detail}`);
  }
  if (offenders.length > 40) {
    console.error(`  … and ${offenders.length - 40} more`);
  }
  console.error('\nRun:  npm run fix:encoding');
  process.exit(1);
}

console.log(`encoding OK — ${files.length} files, no mojibake`);