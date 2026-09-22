#!/usr/bin/env node
//
// Validates the ==UserScript== metadata block.
//
// The header is the install and update contract. A placeholder or
// missing @updateURL means every user is frozen on whatever version
// they first installed, and nothing tells you that has happened.

import { readFileSync } from 'node:fs';

const path = process.argv[2];

if (!path) {
    console.error('usage: validate-header.mjs <script.user.js>');
    process.exit(2);
}

const source = readFileSync(path, 'utf8');

const block = source.match(
    /\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/
);

if (!block) {
    console.error('FAIL: no ==UserScript== metadata block found.');
    process.exit(1);
}

const directives = new Map();

for (const line of block[1].split('\n')) {
    // Valueless directives (@noframes) have no second capture.
    const match = line.match(/^\/\/\s*@(\S+)(?:\s+(.*?))?\s*$/);
    if (match) {
        const key = match[1];
        const value = match[2] || '';
        if (!directives.has(key)) {
            directives.set(key, []);
        }
        directives.get(key).push(value);
    }
}

const errors = [];
const warnings = [];

const REQUIRED = [
    'name',
    'namespace',
    'version',
    'description',
    'match',
    'updateURL',
    'downloadURL'
];

for (const key of REQUIRED) {
    if (!directives.has(key)) {
        errors.push(`missing @${key}`);
    }
}

const first = key => (directives.get(key) || [])[0] || '';

// A placeholder update URL is the silent-failure case this exists for.
for (const key of ['updateURL', 'downloadURL']) {

    const value = first(key);

    if (!value) {
        continue;
    }

    if (/REPLACE-ME|YOUR-USERNAME|YOUR-ORG|example\.com|localhost|TODO/i.test(value)) {
        errors.push(`@${key} is still a placeholder: ${value}`);
    }

    if (!/^https:\/\//.test(value)) {
        errors.push(`@${key} must be https: ${value}`);
    }

    if (!/\.user\.js(\?|$)/.test(value)) {
        errors.push(
            `@${key} must end in .user.js or browsers will not offer ` +
            `a one-click install: ${value}`
        );
    }

}

// Tampermonkey compares versions numerically-ish. A version with a
// leading tag ("beta-0.9.0") does not compare the way you expect and
// can leave users stranded.
const version = first('version');

if (version && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    errors.push(
        `@version "${version}" is not semver (X.Y.Z). Tampermonkey ` +
        'compares versions to decide whether to offer an update; a ' +
        'non-numeric leading segment does not compare reliably.'
    );
}

if (!directives.has('run-at')) {
    warnings.push(
        'no @run-at. Default is document-idle, which is too late to ' +
        'cancel a page meta refresh.'
    );
}

if (!directives.has('noframes')) {
    warnings.push(
        'no @noframes. If the target page ever loads in an iframe you ' +
        'get two panels, two observers and duplicate alerts.'
    );
}

for (const value of directives.get('match') || []) {
    if (/^\*:\/\/\*\//.test(value)) {
        warnings.push(
            `@match "${value}" matches that path on ANY host. Fine for ` +
            'a public repo that must not name an internal hostname - ' +
            'just make sure that is a deliberate choice.'
        );
    }
}

for (const warning of warnings) {
    console.log(`::warning::${warning}`);
}

if (errors.length) {
    for (const error of errors) {
        console.log(`::error::${error}`);
    }
    console.error(`\nFAIL: ${errors.length} header problem(s).`);
    process.exit(1);
}

console.log(`OK: header valid. @version ${version}`);
