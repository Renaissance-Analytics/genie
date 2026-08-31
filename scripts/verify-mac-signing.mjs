#!/usr/bin/env node
/**
 * Report — in the release job's summary — whether the mac app is really signed.
 *
 * Runs after the macOS build. Reads the .app that electron-builder produced,
 * asks `codesign` and `spctl` about it, and prints the verdict where a human
 * will see it instead of leaving it on one line of a 4000-line log.
 *
 * Exits non-zero ONLY when signing secrets were provided and signing did not
 * happen. An unsigned build with no certificate is expected and must still
 * ship. See ./mac-signing-verdict.mjs for why those two cases differ.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { macSigningVerdict } from './mac-signing-verdict.mjs';

/** `codesign`/`spctl` exit non-zero for an unsigned app — that IS the answer,
 *  so the output is what matters, not the status. */
function probe(cmd, args) {
    try {
        return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        return `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
}

function findApp(distDir) {
    for (const dir of ['mac-arm64', 'mac', 'mac-universal']) {
        const base = path.join(distDir, dir);
        if (!fs.existsSync(base)) continue;
        const app = fs.readdirSync(base).find((f) => f.endsWith('.app'));
        if (app) return path.join(base, app);
    }
    return null;
}

const distDir = process.argv[2] ?? 'dist';
const app = findApp(distDir);
if (!app) {
    console.error(`No .app found under ${distDir}/ — nothing to verify.`);
    process.exit(0);
}

const verdict = macSigningVerdict({
    codesign: probe('codesign', ['-dv', '--verbose=4', app]),
    spctl: probe('spctl', ['-a', '-vvv', '-t', 'exec', app]),
    hadSecrets: Boolean(process.env.MAC_CSC_LINK),
});

const icon = verdict.state === 'signed-notarized' ? '✅' : verdict.ok ? '⚠️' : '❌';
const line = `${icon} **macOS signing: ${verdict.state}** — ${verdict.message}`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}
process.exit(verdict.ok ? 0 : 1);
