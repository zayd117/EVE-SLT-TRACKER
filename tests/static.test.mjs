// Static checks on the userscript file: no browser needed. Mirrors CI and
// adds regression guards for bugs that were only visible in the field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { SCRIPT_PATH, SCRIPT_SOURCE as src, SCRIPT_VERSION } from './harness/userscript.mjs';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('script parses (node --check)', () => {
  execFileSync(process.execPath, ['--check', SCRIPT_PATH]);
});

test('userscript header is valid', () => {
  const out = execFileSync(process.execPath, ['scripts/validate-header.mjs', SCRIPT_PATH], { encoding: 'utf8' });
  assert.match(out, /OK: header valid/);
});

test('script is plain ASCII', () => {
  const bad = [...src].findIndex(ch => ch.charCodeAt(0) > 0x7f);
  assert.equal(bad, -1, `non-ASCII character at offset ${bad}`);
});

test('version is consistent: @version, fallback, CHANGELOG top entry', () => {
  const fallback = src.match(/GM_info\.script\.version\s*:\s*'([^']+)'/)[1];
  assert.equal(fallback, SCRIPT_VERSION, 'SCRIPT_VERSION fallback');
  const top = read('CHANGELOG.md').match(/^## \[([^\]]+)\]/m)[1];
  assert.equal(top, SCRIPT_VERSION, 'CHANGELOG top entry');
  assert.doesNotMatch(src.match(/^\/\/ @name\s+(.*)$/m)[1], /v?\d+\.\d+\.\d+/, '@name must not carry a version');
});

test('every GM_* API used is granted, and every grant is used', () => {
  const used = new Set(src.match(/\bGM_[A-Za-z]+(?=\s*[.(])/g));
  const granted = new Set([...src.matchAll(/^\/\/ @grant\s+(\S+)/gm)].map(m => m[1]));
  for (const api of used) assert.ok(granted.has(api), `${api} used but not @grant-ed`);
  for (const api of granted) assert.ok(used.has(api) || api === 'GM_info', `${api} granted but unused`);
});

test('every // ===== SECTION ===== marker has a heading in docs/CODE_NOTES.md', () => {
  const notes = read('docs/CODE_NOTES.md');
  const markers = [...src.matchAll(/^\s*\/\/ ===== (.+?) =====$/gm)].map(m => m[1]);
  assert.ok(markers.length > 40);
  const missing = markers.filter(m => !notes.includes(`## ${m}`));
  assert.deepEqual(missing, []);
});

// Regression (v0.9.9 field bug): Tampermonkey's `window` is a proxy, and
// `new MouseEvent(type, { view: window })` throws "Failed to convert value to
// 'Window'", which killed the TestView Query click.
test('regression: no `view: window` in synthetic event init', () => {
  assert.doesNotMatch(src, /view\s*:\s*window/);
});

test('no credentials or tokens in tracked text files', () => {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n')
    .filter(f => f && !/package-lock\.json$|\.png$/.test(f));
  const secret = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|access_token=[A-Za-z0-9]|-----BEGIN [A-Z ]*PRIVATE KEY|Authorization:\s*Bearer\s+[A-Za-z0-9]/;
  for (const f of files) assert.doesNotMatch(read(f), secret, f);
});

test('only known hosts are hard-coded in the script', () => {
  // Adding a host is a reviewed decision (public repo). Update this list only
  // together with README "Privacy" and docs/TESTING.md.
  const allowed = new Set(['jira.synnex.com', 'testview-eve-fmt.hyvesolutions.org', 'github.com',
    'raw.githubusercontent.com', 'www.w3.org']);
  const hosts = new Set([...src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(m => m[1].toLowerCase()));
  for (const h of hosts) assert.ok(allowed.has(h), `unexpected host in script: ${h}`);
});
