#!/usr/bin/env node
/**
 * THE PROBE (genie#1340), applied to the BUILD INPUT on the test VM only, never committed: prism-harness's
 * `FileSessionStore.readLog` parses only the LAST 4000 lines of a thread log and counts the rest by newline, so every
 * history read gives the window the same last-3000-row window (HISTORY_LIMIT) without parsing the whole file. Everything
 * else — the rows the window draws, the agents, their streams — is unchanged. If the lag goes with it, the whole-file
 * parse is the cause.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'node_modules/@particle-academy/prism-harness/dist/stores/file-session-store.js';
const src = readFileSync(file, 'utf8');
const start = src.indexOf('    async readLog(key) {');
const end = src.indexOf('    async logLength(key) {');
if (start < 0 || end < 0) throw new Error('readLog not found: the probe does not apply');
const probe = `    async readLog(key) {
        let buf;
        try { buf = await readFile(this.#logPathFor(key)); }
        catch (error) { if (isMissing(error)) return null; throw error; }
        const KEEP = 4000;
        const ring = new Float64Array(KEEP + 1);
        let count = 0;
        for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) { ring[count % (KEEP + 1)] = i; count += 1; }
        const from = count > KEEP ? ring[count % (KEEP + 1)] + 1 : 0;
        const last = count > 0 ? ring[(count - 1) % (KEEP + 1)] : 0;
        const lines = buf.subarray(from, last).toString('utf8').split('\\n');
        const entries = lines.filter((l) => l.length > 0).map((l) => JSON.parse(l));
        this.#logs.set(key, { size: buf.length, count });
        return entries;
    }
`;
writeFileSync(file, src.slice(0, start) + probe + src.slice(end));
console.log('probe applied: readLog parses only the last 4000 lines');
