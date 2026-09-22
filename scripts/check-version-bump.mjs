#!/usr/bin/env node
//
// Fails a PR that changes the script without increasing @version.
//
// Tampermonkey only offers an update when the remote @version is
// GREATER than the installed one. Merging a fix without a bump ships
// the fix to nobody, and there is no signal that it happened.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const [, , path, baseRef] = process.argv;

if (!path || !baseRef) {
    console.error('usage: check-version-bump.mjs <script.user.js> <base-ref>');
    process.exit(2);
}

const versionOf = source => {
    const match = source.match(/^\/\/\s*@version\s+(\S+)\s*$/m);
    return match ? match[1] : null;
};

const head = versionOf(readFileSync(path, 'utf8'));

let base = null;
let baseSource = null;

try {
    baseSource = execSync(`git show ${baseRef}:${path}`, { encoding: 'utf8' });
    base = versionOf(baseSource);
} catch (error) {
    console.log(`::notice::${path} does not exist on ${baseRef} - new file, skipping.`);
    process.exit(0);
}

if (!head || !base) {
    console.log('::error::Could not read @version from one of the revisions.');
    process.exit(1);
}

// Nothing changed in the script itself - a docs/CI-only PR.
if (baseSource === readFileSync(path, 'utf8')) {
    console.log('Script unchanged; no bump required.');
    process.exit(0);
}

const parse = v =>
    v.split('-')[0].split('.').map(n => parseInt(n, 10) || 0);

const compare = (a, b) => {
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
};

if (compare(head, base) <= 0) {
    console.log(
        `::error::@version is ${head} but ${baseRef} is already ${base}. ` +
        'Bump the version or Tampermonkey will never offer this update. ' +
        'Run: ./scripts/release.sh patch "<what changed>"'
    );
    process.exit(1);
}

console.log(`OK: ${base} -> ${head}`);
