#!/usr/bin/env node
/**
 * PUTS genie#1457 BACK, in a throwaway copy of the tree, so `scripts/agent-key-no-window-cdp.mjs run --expect-bug` can be seen failing on
 * the real app. Run it BEFORE `npm run build`. It edits src/ and refuses anywhere but a test machine, and never restores: the tree it
 * edits is shipped for this one job.
 *
 *   npm ci && node scripts/perf-lag/agent-key-bug-back.mjs && npm run build
 *   node scripts/smoke-seed.mjs && node scripts/agent-key-no-window-cdp.mjs seed
 *   (launch as for the positive run)
 *   node scripts/agent-key-no-window-cdp.mjs run --expect-bug
 *
 * `### agent-key=PASS` there means: checks 1 to 7 held, and B started with no Tynn key, which is the bug.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';

if (!process.env.CI && userInfo().username !== 'genie') { console.error('refusing: this breaks src/; test machines only'); process.exit(2); }
const FILE = 'src/main/session-engine-server.ts';
const raw = readFileSync(FILE, 'utf8');
const crlf = raw.includes('\r\n');
const text = raw.split('\r\n').join('\n');
// The host prepares its agents, window or no window, so the bug is: it hands out nothing it prepared.
const FIXED = `                const held = await this.#options.agentKeys?.(record, cwd, signal);
                if (held?.note) this.#host?.notice(record.id, held.note);
                return [...own, ...(held?.servers ?? [])];
`;
const THE_BUG = `                return own;
`;
if (text.split(FIXED).length !== 2) { console.error(`the fix is not where it was in ${FILE}`); process.exit(1); }
const next = text.replace(FIXED, () => THE_BUG);
writeFileSync(FILE, crlf ? next.split('\n').join('\r\n') : next);
if (readFileSync(FILE, 'utf8').includes('held?.servers')) { console.error('the edit did not take'); process.exit(1); }
console.log(`### agent-key-bug-back=PASS  ${FILE} hands out only the host's own entry`);
