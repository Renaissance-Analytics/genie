import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logonEntry } from '../src/core/logon.js';

/*
 * THE LOGON TABLE, ONE FILE FOR BOTH LANGUAGES (Tynn #1058 L5). The launcher now writes the logon entry and decides what its
 * run does (native/launcher/src/logon.rs), with `logonEntry` unchanged. test/fixtures/logon-table.json holds the table:
 * this reads it against `logonEntry`, and native/launcher/tests/logon_table.rs reads the same file against the launcher's
 * plan, so the two cannot drift.
 */
interface Row {
    readonly name: string;
    readonly leftRunning: boolean;
    readonly setting: boolean;
    readonly startMinimized: boolean;
    readonly entry: { readonly launchAtLogin: boolean; readonly startMinimized: boolean };
    readonly atLogon: { readonly startHost: boolean; readonly openWindow: boolean };
}

const rows = (JSON.parse(readFileSync(join(__dirname, 'fixtures', 'logon-table.json'), 'utf8')) as { rows: Row[] }).rows;

describe('the logon table (shared with the launcher)', () => {
    it('holds the four rows: left running / shut down x the setting on / off', () => {
        expect(rows.filter((r) => !r.startMinimized).map((r) => [r.leftRunning, r.setting])).toEqual([[true, true], [true, false], [false, true], [false, false]]);
    });

    it.each(rows.map((r) => [r.name, r] as const))('%s: logonEntry gives the table\'s entry', (_name, row) => {
        expect(logonEntry({ leftRunning: row.leftRunning, setting: row.setting, startMinimized: row.startMinimized })).toEqual(row.entry);
    });

    it('the run at logon: the host starts whenever the entry is there; a window opens only when not start-minimised', () => {
        for (const row of rows) {
            expect(row.atLogon.startHost, row.name).toBe(row.entry.launchAtLogin);
            expect(row.atLogon.openWindow, row.name).toBe(row.entry.launchAtLogin && !row.entry.startMinimized);
        }
    });
});
