import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linuxRow, linuxRows, linuxSh, windowsFunction, windowsPs1, windowsRows } from './helpers/ci-scripts.js';

/*
 * LOGON START, PROVEN ON A REAL MACHINE (Tynn #1036 P6-3, task #1501). src/core/logon.ts decides, src/main/tray-residence.ts
 * writes, and both have unit tests; this holds the rows that read what a PACKAGED Genie really wrote at the OS:
 *
 *   the `logon` row (linux.sh, windows.ps1): scripts/logon-entry-cdp.mjs in mode `table` reads the real entry back (Windows:
 *   the HKCU Run value and its StartupApproved flag, with `reg query`; Linux: ~/.config/autostart/genie.desktop's Exec and
 *   Hidden lines, and what systemd's own xdg-autostart generator makes of it), switches the setting on and off live (the entry
 *   appears and goes, the window and genie-host pids stay), and walks the four logon cases (left running or shut down ×
 *   setting on or off) against what is written;
 *
 *   the real logon (a focused job, not the gate: it restarts the machine or the session): Windows reboots with autologon
 *   (run-job.sh's #REBOOT stages), Linux restarts SDDM, whose autologin starts a new Hyprland session; the setting off after
 *   "Shut down everything" stays down, and the setting on after it comes back, genie-host up and no window shown.
 *
 * Break probes: no-follow and mark-ignored change the product's source before it is built (the anchors are held here, so a
 * moved line fails this test instead of the probe silently patching nothing); no-entry and stale-entry change the OS entry
 * just before the logon, so the start and the stay-down checks each go red for their own reason.
 */
const root = join(__dirname, '..');
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');
const code = (text: string, comment: RegExp) => text.split('\n').filter((l) => !comment.test(l)).join('\n');
const driver = () => code(read('scripts', 'logon-entry-cdp.mjs'), /^\s*(\/\/|\*|\/\*\*)/);
const linuxReal = () => code(read('scripts', 'vm-logon-linux.sh'), /^\s*#/);
const windowsReal = () => code(read('scripts', 'vm-logon-windows.ps1'), /^\s*#/);

describe('registered as a row on both platforms, before the rows that replace the install', () => {
    it('linux.sh: logon after package-fuse and before client-only-update, its timeout under its ceiling, leftovers reaped', () => {
        expect(linuxRows).toContain('logon');
        expect(linuxRows.indexOf('logon')).toBeGreaterThan(linuxRows.indexOf('package-fuse'));
        expect(linuxRows.indexOf('logon')).toBeLessThan(linuxRows.indexOf('client-only-update'));
        expect(linuxRow('logon')).toBe('row_logon() { need_install && need_electron && need_display && timeout 840 bash scripts/vm-logon-linux.sh table; }');
        expect(linuxSh).toMatch(/\n\s*logon\) echo 900 ;;/);
        expect(/case " ([^"\n]*) " in\n\s*\*" \$name "\*\) reap_leftovers "\$name" ;;/.exec(linuxSh)?.[1]?.split(' ')).toContain('logon');
    });

    it('windows.ps1: logon after packaged-launcher and before client-only-update, its function, its ceiling', () => {
        expect(windowsRows).toContain('logon');
        expect(windowsRows.indexOf('logon')).toBeGreaterThan(windowsRows.indexOf('packaged-launcher'));
        expect(windowsRows.indexOf('logon')).toBeLessThan(windowsRows.indexOf('client-only-update'));
        expect(windowsFunction('Row-logon')).toBe("function Row-logon { Need-Build; Need-TestMachine; Run 'vm-logon' { powershell -NoProfile -ExecutionPolicy Bypass -File scripts/vm-logon-windows.ps1 -Mode table } }");
        expect(windowsPs1).toMatch(/\n\s*'logon' \{ return 900 \}/);
    });
});

describe('the entry read back is the OS’s own', () => {
    it('Windows: the HKCU Run value and its StartupApproved flag, read with reg query, found by the packaged exe in its data', () => {
        expect(driver()).toContain("'HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run'");
        expect(driver()).toContain("'HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\StartupApproved\\\\Run'");
        expect(driver()).toMatch(/execFileSync\('reg', \['query', key\]/);
    });

    it('Linux: the autostart file’s Exec and Hidden lines, and what systemd-xdg-autostart-generator makes of it', () => {
        expect(driver()).toMatch(/join\(configHome\(\), 'autostart', 'genie\.desktop'\)/);
        expect(driver()).toMatch(/\^Exec=/);
        expect(driver()).toMatch(/\^Hidden=/);
        expect(driver()).toContain('systemd-xdg-autostart-generator');
    });

    it('the tray-only flag is the one the product writes and reads (core/tray-resident.ts HIDDEN_ARG)', () => {
        expect(read('src', 'core', 'tray-resident.ts')).toMatch(/export const HIDDEN_ARG = '--hidden';/);
        expect(driver()).toMatch(/const HIDDEN = '--hidden';/);
    });
});

describe('the table: live switching, and the four logon cases', () => {
    it('the setting is switched through the page, as Settings does, and nothing restarts: the window and host pids are compared', () => {
        expect(driver()).toMatch(/features\.act\(\{ kind: 'settings\.set', key: \$\{JSON\.stringify\(key\)\}, value: \$\{JSON\.stringify\(value\)\} \}\)/);
        expect(driver()).toMatch(/function samePids\(/);
    });

    it('every case of core/logon.ts is walked, by the tray’s own items', () => {
        for (const label of ['left running + setting off', 'left running + setting on', 'shut down + setting on', 'shut down + setting off']) expect(driver()).toContain(label);
        expect(driver()).toMatch(/trayClick\([^)]*'Just close the UI'/);
        expect(driver()).toMatch(/trayClick\([^)]*'Shut down everything'/);
        expect(driver()).toMatch(/trayClick\([^)]*'Open Genie'/);
    });
});

describe('break probes', () => {
    it('the source probes name lines that are in the source now (a moved line fails here, not silently in the probe)', () => {
        const residence = read('src', 'main', 'tray-residence.ts');
        const anchors = [...driver().matchAll(/anchor: (".*?"|'.*?'),/g)].map((m) => JSON.parse(m[1]!.startsWith("'") ? `"${m[1]!.slice(1, -1).replace(/"/g, '\\"')}"` : m[1]!) as string);
        expect(anchors.length).toBe(2);
        for (const a of anchors) expect(residence.split(a).length - 1).toBe(1);
        expect(driver()).toMatch(/'no-follow': \{/);
        expect(driver()).toMatch(/'mark-ignored': \{/);
    });

    it('the logon probes change the entry just before the logon, in both real jobs', () => {
        expect(linuxReal()).toMatch(/no-entry\) rm -f "\$AUTOSTART"/);
        expect(linuxReal()).toMatch(/stale-entry\) printf/);
        expect(windowsReal()).toMatch(/'no-entry' \{ foreach \(\$v in \$ours\) \{[^\n]*reg delete \$runKey \/v \$v \/f/);
        expect(windowsReal()).toMatch(/'off:stale-entry' \{[^\n]*reg add \$runKey /);
    });
});

describe('a real logon', () => {
    it('Linux restarts SDDM and the user manager (autologin starts a new session), and checks a NEW Hyprland session before it reads anything', () => {
        // SDDM down, the user manager afresh (it makes the autostart units when it starts), SDDM up: a logon's order.
        const order = ['sudo -n systemctl stop sddm', 'sudo -n systemctl restart "user@$(id -u).service"', 'sudo -n systemctl start sddm'].map((c) => linuxReal().indexOf(c));
        expect(order.every((i) => i > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(linuxReal()).toMatch(/new_session/);
    });

    it('Windows: the job file splits its stages with #REBOOT; each stage after one waits for the logon first', () => {
        const job = 'scripts/azure-jobs/logon-real-windows.ps1';
        expect(existsSync(join(root, job))).toBe(true);
        const text = read(job);
        expect(text.split('\n').filter((l) => l === '#REBOOT').length).toBeGreaterThanOrEqual(2);
        expect(windowsReal()).toMatch(/'after-logon'/);
    });

    it('both: coming back means genie-host alive AND no window shown; staying down means no Genie process at all', () => {
        expect(driver()).toMatch(/function noWindowShown\(/);
        expect(driver()).toMatch(/expect === 'start'/);
        expect(driver()).toMatch(/expect === 'none'/);
    });
});
