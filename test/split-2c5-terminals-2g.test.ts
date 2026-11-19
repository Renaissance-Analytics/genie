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

describe('main’s terminals replica is step 2g’s', () => {
    it('the engine row is move:2g', () => {
        expect(WINDOW_ENGINE_INVENTORY.find(([use]) => use === 'terminals')).toEqual(['terminals', 'move:2g']);
    });

    it('its readers are only the MCP tool server’s terminal tools and the tray/quit counts, list and closeAll (COUNTED)', () => {
        const main = code('src/main/main.ts');
        expect(terminalReads(main)).toEqual({
            // The tray's count (hostActivityNow) and the quit plan's.
            count: 2,
            // The Restart/Shut-down list (stoppingNow), and the tool server's list.
            list: 2,
            // The tool server's terminal tools (genieToolDeps).
            open: 1, write: 1, scrollback: 1, finished: 1,
            // Quit: nothing Genie spawned outlives it (§7.1).
            closeAll: 1,
        });
        expect(main).toMatch(/terminals: \{\s*list: \(\) => terminals!\.list\(\),\s*open: \(options\) => terminals!\.open\(options\),/);
    });

    it('CONTROL: the scanner counts a reader, and skips a quoted method name and a member of something else', () => {
        expect(terminalReads("terminals?.count; x.terminals.list(); call('terminals.scratch'); terminals!.open(o);")).toEqual({ count: 1, open: 1 });
    });
});
