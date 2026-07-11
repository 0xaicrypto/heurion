/**
 * Headless round-trip test for src/lib/writing-doc-serial.ts — proves
 * string → TipTap-JSON doc → string identity for the Writing Studio
 * wire format ({{ref:ID}} tokens, '\n' paragraph breaks).
 *
 * The serializer is a PURE module (no TipTap imports) precisely so it
 * can run here in plain node: we transpile the .ts source with the
 * repo's own typescript and evaluate it as CJS.
 *
 *   node scripts/test-writing-doc-serial.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require(path.join(here, '..', 'node_modules', 'typescript'));

const srcPath = path.join(here, '..', 'src', 'lib', 'writing-doc-serial.ts');
const js = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('exports', 'module', 'require', js)(mod.exports, mod, require);
const { parseBodyToDoc, serializeDocToBody } = mod.exports;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ── string → doc → string identity ───────────────────────────── */

const roundTripCases = [
  ['empty body',                ''],
  ['plain text',                'plain text, no tokens'],
  ['multi-paragraph',           'para one\npara two\n\npara four'],
  ['token at start',            '{{ref:abc123}} opens the doc'],
  ['token in middle',           'baseline {{ref:r-42}} then progress'],
  ['token at end',              'the cohort: {{ref:zzz}}'],
  ['adjacent tokens',           '{{ref:a}}{{ref:b}}'],
  ['token-only line',           'x\n{{ref:q}}\ny'],
  ['trailing newline',          'text with trailing newline\n'],
  ['leading newline',           '\nstarts on line two'],
  ['consecutive newlines',      'a\n\n\nb'],
  ['CJK around token',          '患者{{ref:r1}}影像随访情况良好。'],
  ['near-miss braces (no token)', 'a {b} }} {{ref: not-closed {{x:y}}'],
  ['empty-id near-miss',        'a {{ref:}} b'],
  ['whitespace preservation',   '  indented\ttab  \n  more  '],
];

console.log('round-trip: serializeDocToBody(parseBodyToDoc(s)) === s');
for (const [name, s] of roundTripCases) {
  const out = serializeDocToBody(parseBodyToDoc(s));
  check(name, out === s, `${JSON.stringify(s)} → ${JSON.stringify(out)}`);
}

/* ── doc → string → doc identity (for parser-produced docs) ───── */

console.log('round-trip: parseBodyToDoc(serializeDocToBody(d)) ≡ d');
for (const [name, s] of roundTripCases) {
  const d1 = parseBodyToDoc(s);
  const d2 = parseBodyToDoc(serializeDocToBody(d1));
  check(name, JSON.stringify(d1) === JSON.stringify(d2));
}

/* ── structural expectations ──────────────────────────────────── */

console.log('structure');
{
  const d = parseBodyToDoc('');
  check('empty body = one empty paragraph',
    d.content.length === 1 && d.content[0].type === 'paragraph'
      && d.content[0].content === undefined,
    JSON.stringify(d));
}
{
  const d = parseBodyToDoc('a\nb');
  check('newline = paragraph break (2 paragraphs)', d.content.length === 2);
}
{
  const d = parseBodyToDoc('hi {{ref:R7}}!');
  const inl = d.content[0].content;
  check('token → refChip atom between text nodes',
    inl.length === 3
      && inl[0].type === 'text' && inl[0].text === 'hi '
      && inl[1].type === 'refChip' && inl[1].attrs.refId === 'R7'
      && inl[2].type === 'text' && inl[2].text === '!',
    JSON.stringify(inl));
}
{
  const d = parseBodyToDoc('{{ref:a}}{{ref:b}}');
  const inl = d.content[0].content;
  check('adjacent tokens → two chips, no empty text nodes',
    inl.length === 2 && inl.every((n) => n.type === 'refChip'),
    JSON.stringify(inl));
}
{
  // ProseMirror's toJSON() omits `content` for empty paragraphs and
  // may include extra fields — the serializer must tolerate both.
  const s = serializeDocToBody({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'refChip', attrs: { refId: 'x' } }] },
    ],
  });
  check('PM-style doc (empty ¶ without content)', s === 'a\n\n{{ref:x}}', JSON.stringify(s));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall serialization round-trip tests passed');
