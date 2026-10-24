// Static checks on EVE_SLT_TRACKER.user.js (3.x). Browser behavior of this
// script was checked on a mock board only; see CHANGELOG-3.1.2.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FILE = new URL('../EVE_SLT_TRACKER.user.js', import.meta.url).pathname;
const src = readFileSync(FILE, 'utf8');

test('3.x script parses (node --check)', () => {
  execFileSync(process.execPath, ['--check', FILE]);
});

test('3.x userscript header is valid', () => {
  const out = execFileSync(process.execPath, ['scripts/validate-header.mjs', FILE], { encoding: 'utf8' });
  assert.match(out, /OK: header valid/);
});

test('3.x script is plain ASCII', () => {
  assert.equal([...src].findIndex(ch => ch.charCodeAt(0) > 0x7f), -1);
});

test('3.x @version matches the SCRIPT_VERSION fallback', () => {
  const header = src.match(/^\/\/ @version\s+(\S+)/m)[1];
  const fallback = src.match(/GM_info\.script\.version\s*:\s*'([^']+)'/)[1];
  assert.equal(fallback, header);
});
