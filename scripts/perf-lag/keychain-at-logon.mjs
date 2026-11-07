#!/usr/bin/env node
/**
 * THE KEYCHAIN RIGHT AFTER A LOGON (run by scripts/perf-lag/keychain-sessions-windows.ps1, from the user's Run key at sign-in). A host started as a person logs on could reach Credential Manager before
 * it is ready. This keeps trying a set, read and delete, and writes down what it saw: the first error's own words, how long until the first success, and how many tries. It writes a
 * test word to one entry and removes it. The result goes to the file named by its one argument.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const out = process.argv[2];
const repo = process.argv[3] ?? process.cwd();
const began = Date.now();
writeFileSync(out, `started ${new Date().toISOString()}\n`);
const { AsyncEntry } = createRequire(`${repo}/`)('@napi-rs/keyring');
const say = (line) => appendFileSync(out, `${line}\n`);
let tries = 0;
let firstError = null;
for (;;) {
    tries += 1;
    try {
        const entry = new AsyncEntry('GenieKeychainMeasure', 'at-logon');
        await entry.setPassword('at-logon');
        if ((await entry.getPassword()) !== 'at-logon') throw new Error('read back differently');
        await entry.deletePassword();
        say(`### keychain-at-logon first-success=${Date.now() - began} ms after this started, ${tries} tries; first error: ${firstError ?? 'none'}`);
        break;
    } catch (error) {
        firstError ??= `${error instanceof Error ? error.message : String(error)} (at ${Date.now() - began} ms)`;
    }
    if (Date.now() - began > 300_000) { say(`### keychain-at-logon gave-up=300000 ms, ${tries} tries; first error: ${firstError}`); break; }
    await new Promise((r) => setTimeout(r, 250));
}
process.exit(0);
