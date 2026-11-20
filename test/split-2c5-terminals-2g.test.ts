import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WINDOW_ENGINE_INVENTORY } from '../src/core/ipc-inventory.js';

/*
 * CLIENT/HOST SPLIT STEP 2c-5 (Tynn #898, story #897, task #1434; re-label approved by the coordinator, 2026-11-19). After
 * 2c-2 (the crash report) and 2c-4 (the scratch terminal), main's `terminals` replica (agentEngineLink.client.terminals())
 * is read only by main's own MCP tool server (genieToolDeps' terminal tools, step 2g) and by the tray count, the
 * Restart/Shut-down list, the quit plan and quit's closeAll. Those read it synchronously, so they move with the replica in
 * 2g rather than as a second copy beside it. The row is 2g's, and this pins who reads it, so the reason cannot drift.
 */

const code = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

/** Each member main reads on its `terminals` variable (never a `.terminals` member, never a quoted method name). */
function terminalReads(text: string): Record<string, number> {
    const reads: Record<string, number> = {};
    for (const m of text.matchAll(/(?<![.\w'"`])terminals[!?]?\.(\w+)/g)) reads[m[1]!] = (reads[m[1]!] ?? 0) + 1;
    return reads;
}

describe('main’s terminals replica is gone (2g-2, Tynn #953)', () => {
    it('the engine row has left', () => {
        expect(WINDOW_ENGINE_INVENTORY.find(([use]) => use === 'terminals')).toBeUndefined();
    });

    it('main reads no terminals replica: the tray and the quit read genie-host’s summary, and its tool server has none (COUNTED)', () => {
        const main = code('src/main/main.ts');
        expect(terminalReads(main)).toEqual({});
        expect(main).not.toMatch(/client\.terminals\(\)/);
    });

    it('CONTROL: the scanner counts a reader, and skips a quoted method name and a member of something else', () => {
        expect(terminalReads("terminals?.count; x.terminals.list(); call('terminals.scratch'); terminals!.open(o);")).toEqual({ count: 1, open: 1 });
    });
});
