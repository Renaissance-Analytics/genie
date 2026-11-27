import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linuxRow, linuxRows, linuxSh, windowsFunction, windowsPs1, windowsRows } from './helpers/ci-scripts.js';

/*
 * LOGON IS THE LAUNCHER'S, PROVEN ON A REAL MACHINE (Tynn #1058 L5; was #1036 P6-3's client-written entry, task #1501).
 * The launcher writes the entry (Windows: the HKCU Run value `Genie`; Linux: ~/.config/autostart/genie.desktop), running
 * itself with --logon, and its run decides with the logon table (test/fixtures/logon-table.json, read by
 * test/logon-table.test.ts and the launcher's cargo test logon_table.rs). These rows read what the real launcher did:
 *
 *   the `logon` row (both OSes): for each of the table's four rows, the entry read back at the OS (written, running the
 *   launcher with --logon, or absent) and the launcher's --logon run: what started and what did not;
 *   `logon-launcher` (a focused job, not the gate): Windows restarts the VM three times (run-job.sh's #REBOOT stages), Linux
 *   starts three new logons (SDDM and the user manager restarted: the Linux job runner has no reboot between stages).
 */
const root = join(__dirname, '..');
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');
const code = (text: string, comment: RegExp) => text.split('\n').filter((l) => !comment.test(l)).join('\n');
const linuxScript = () => code(read('scripts', 'vm-logon-launcher-linux.sh'), /^\s*#/);
const windowsScript = () => code(read('scripts', 'vm-logon-launcher-windows.ps1'), /^\s*#/);

describe('the logon row, on both platforms, after the packages it installs', () => {
    it('linux.sh: logon after package-tracks, through the launcher script in table mode, under its ceiling', () => {
        expect(linuxRows).toContain('logon');
        expect(linuxRows.indexOf('logon')).toBeGreaterThan(linuxRows.indexOf('package-tracks'));
        expect(linuxRow('logon')).toBe('row_logon() { need_tracks && need_display && timeout 840 bash scripts/vm-logon-launcher-linux.sh table; }');
        expect(linuxSh).toMatch(/\n\s*logon\) echo 900 ;;/);
    });

    it('windows.ps1: logon after package-tracks, through the launcher script in table mode, its ceiling', () => {
        expect(windowsRows).toContain('logon');
        expect(windowsRows.indexOf('logon')).toBeGreaterThan(windowsRows.indexOf('package-tracks'));
        expect(windowsFunction('Row-logon')).toBe("function Row-logon { Need-Tracks; Need-TestMachine; Run 'vm-logon-launcher' { powershell -NoProfile -ExecutionPolicy Bypass -File scripts/vm-logon-launcher-windows.ps1 -Mode table } }");
        expect(windowsPs1).toMatch(/\n\s*'logon' \{ return 900 \}/);
    });

    it('the client-written entry’s scripts are gone: nothing but the launcher writes the entry', () => {
        for (const f of ['logon-entry-cdp.mjs', 'vm-logon-linux.sh', 'vm-logon-windows.ps1']) expect(existsSync(join(root, 'scripts', f)), f).toBe(false);
    });
});

describe('the table: the four rows, at the OS and in the --logon run', () => {
    it('Linux walks the four rows: entry, host and window as the table says', () => {
        const s = linuxScript();
        expect(s).toMatch(/case_row left-on on yes yes yes no/);
        expect(s).toMatch(/case_row left-off off yes yes yes no/);
        expect(s).toMatch(/case_row down-on on no yes yes yes/);
        expect(s).toMatch(/case_row down-off off no no no no/);
        // The entry runs the launcher's link with --logon, exactly.
        expect(s).toContain('[ "$entry" = "Exec=\\"$GENIE\\" --logon" ]');
        // A row with nothing to start: no host, and the launcher does not stay up.
        expect(s).toMatch(/kill -0 "\$runner" 2>\/dev\/null && failed\+=" \$name:launcher-stayed"/);
    });

    it('Windows walks the same four rows against the HKCU Run value', () => {
        const s = windowsScript();
        expect(s).toMatch(/Case-Row 'left-on' 'on' \$true \$true \$true \$false/);
        expect(s).toMatch(/Case-Row 'left-off' 'off' \$true \$true \$true \$false/);
        expect(s).toMatch(/Case-Row 'down-on' 'on' \$false \$true \$true \$true/);
        expect(s).toMatch(/Case-Row 'down-off' 'off' \$false \$false \$false \$false/);
        expect(s).toMatch(/\$RunKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'/);
        expect(s).toMatch(/if \(\$v -ne "`"\$Built`" --logon"\)/);
    });
});

describe('logon-launcher: real logons', () => {
    it('Windows: the VM restarted between stages; stays down, then the host and a window, then the host and no window', () => {
        const job = read('scripts', 'azure-jobs', 'logon-launcher-windows.ps1');
        expect(job.match(/^#REBOOT$/gm) ?? []).toHaveLength(3);
        const order = ["'arm-off'", "'none'", "'arm-on'", "'window'", "'arm-left'", "'hidden'"].map((m) => job.indexOf(m));
        expect(order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1]!))).toBe(true);
    });

    it('Linux: three new logons in the same order, each after-logon screen photographed', () => {
        const s = linuxScript();
        expect(s).toMatch(/after_logon down-off no no no/);
        expect(s).toMatch(/after_logon down-on yes yes yes/);
        expect(s).toMatch(/after_logon left yes yes no/);
        expect(s).toMatch(/grim "\$OUT\/after-logon-\$name-linux\.png"/);
        expect(read('scripts', 'azure-jobs', 'logon-launcher-linux.sh')).toMatch(/bash scripts\/vm-logon-launcher-linux\.sh real/);
    });
});
