/**
 * Reverses mojibake: text that was UTF-8 but decoded as cp1252 or latin-1 at
 * some point in the tool chain and then written back out.
 *
 * Two variants are in the wild, and both are present in this repository:
 *
 *   UTF-8 bytes    decoded as cp1252    decoded as latin-1
 *   E2 80 A6 (…)   'â' '€' '¦'  (3 cp)  'â' U+0080 '¦'  (3 latin-1)
 *   C2 B7 (·)     'Â' '·'                 'Â' U+00B7
 *
 * A naive fix of `codepoint & 0xFF` is WRONG for the cp1252 variant: '€' is
 * U+20AC, and masking it to 0xAC yields '&' — so every ellipsis silently
 * became an ampersand. This maps the cp1252 punctuation block back to its
 * actual byte before assembling the byte string.
 *
 * Run:  node scripts/fix-mojibake.mjs            (dry run)
 *       node scripts/fix-mojibake.mjs --write
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const WRITE = process.argv.includes('--write');

/**
 * cp1252 code points that do NOT equal their byte value.
 *
 * In the range 0x80–0x9F, cp1252 maps printable characters where Latin-1 has
 * control codes. This is the inverse of that table, and it is the part that
 * makes the repair correct rather than approximately correct.
 */
const CP1252_HIGH = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

/**
 * A code point that is the visible residue of a mis-decode.
 *
 * 'Â', 'Ã', 'â' and 'ð' lead every cp1252/latin-1 round-trip artefact, and a
 * legitimate string would not contain them.
 */
const MOJIBAKE = /[\u00C2\u00C3\u00E2\u00E3\u00F0][\u0080-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u20AC\u2122\u0153\u017E\u2020\u2021\u2026\u02C6\u2030\u02DC\u0160\u0161\u0152\u0153\u2039\u203A]|\u00C2[\u00A0-\u00BF]|[\u00E2\u00F0]\u0080/;

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

/** Code point -> byte, honouring the cp1252 high block. */
function toByte(cp) {
  if (Object.prototype.hasOwnProperty.call(CP1252_HIGH, cp)) return CP1252_HIGH[cp];
  return cp & 0xff;
}

/** One candidate repair: current codepoints read as bytes, decoded as UTF-8. */
function repair(text) {
  const bytes = new Uint8Array([...text].map((ch) => toByte(ch.codePointAt(0))));
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (decoded === text) return null;
  // Reject if the signature survives: a partial repair would corrupt real text.
  if (MOJIBAKE.test(decoded)) return null;
  return decoded;
}

/**
 * Tries a cp1252-flavoured repair, then a latin-1-flavoured one.
 *
 * Order matters only for which one is attempted first; a wrong guess leaves the
 * signature intact and is rejected, so both are safe to try.
 */
function tryRepair(text) {
  // Variant A: the high block maps through cp1252 (default above).
  const a = repair(text);
  if (a && !MOJIBAKE.test(a)) return a;

  // Variant B: plain latin-1, i.e. mask every codepoint.
  const bytes = new Uint8Array(
    [...text].map((ch) => ch.codePointAt(0) & 0xff)
  );
  const b = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (b !== text && !MOJIBAKE.test(b)) return b;

  return null;
}

const files = [
  ...walk(join(ROOT, 'src')),
  ...['README.md', 'RUN-THIS-FIRST.md', 'AUDIT_REDESIGN_REPORT.md', 'SESSION_NOTES.md']
    .map((n) => join(ROOT, n))
    .filter((p) => {
      try {
        statSync(p);
        return true;
      } catch {
        return false;
      }
    }),
];

let scanned = 0;
let fixed = 0;
const unfixed = [];

for (const file of files) {
  scanned++;
  const original = readFileSync(file, 'utf8');
  if (!MOJIBAKE.test(original)) continue;

  const rel = file.slice(ROOT.length + 1);
  const repaired = tryRepair(original);

  if (repaired === null) {
    unfixed.push(rel);
    console.log(`  UNREPAIRABLE  ${rel}`);
    continue;
  }

  fixed++;
  console.log(`  ${WRITE ? 'fixed' : 'would fix'}  ${rel}`);
  if (WRITE) writeFileSync(file, repaired, 'utf8');
}

console.log(
  `\n${scanned} files scanned, ${fixed + unfixed.length} affected, ${fixed} ${
    WRITE ? 'fixed' : 'repairable'
  }, ${unfixed.length} unrepairable`
);

if (unfixed.length > 0) {
  console.log('\nThe unrepairable files need a human pass:');
  unfixed.forEach((f) => console.log(`  ${f}`));
  process.exitCode = 1;
}