import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { linuxRow, linuxRows, linuxSh, windowsPs1, windowsRows } from './helpers/ci-scripts.js';

/**
 * VERSION SKEW, A ROW OF ITS OWN (Tynn #1058 L8; the spec: "Mixed pairs are tested, not assumed: the previous published
 * client against the new host and the reverse, as real processes"). scripts/launcher-updates-row.mjs --row version-skew runs
 * the INSTALLED client of one build against the installed host of the other, both ways, with a turn streamed both ways.
 */
const row = () => readFileSync('scripts/launcher-updates-row.mjs', 'utf8').replace(/\r\n/g, '\n');
const lib = () => readFileSync('scripts/launcher-row-lib.mjs', 'utf8').replace(/\r\n/g, '\n');

describe('the version-skew row', () => {
    it('is registered last on both OSes, with its function, its ceiling and its reaping', () => {
        expect(linuxRows.at(-1)).toBe('version-skew');
        expect(windowsRows.at(-1)).toBe('version-skew');
        expect(linuxRow('version-skew')).toBe('row_version-skew() { need_build && need_tracks && need_display && on_display timeout 1500 env LAUNCHER_ROW_OUT="$OUT/version-skew" LAUNCHER_ROW_KEY_DIR="$SETUP" CDP_PORT=9419 LAUNCHER_ROW_DEADLINE_MS=1380000 node scripts/launcher-updates-row.mjs --row version-skew; }');
        expect(linuxSh).toMatch(/\n\s*version-skew\) echo 1680 ;;/);
        expect(/case " ([^"\n]*) " in\n\s*\*" \$name "\*\) reap_leftovers "\$name" ;;/.exec(linuxSh)?.[1]?.split(' ')).toContain('version-skew');
        expect(windowsPs1).toContain("function Row-version-skew {\n    Need-Build; Need-Tracks; Need-TestMachine\n    Invoke-LauncherUpdatesRow 'version-skew' @{ LAUNCHER_ROW_OUT = (Join-Path $Out 'version-skew'); LAUNCHER_ROW_KEY_DIR = $Setup; CDP_PORT = '9419'; LAUNCHER_ROW_DEADLINE_MS = '1800000' }\n}");
        expect(windowsPs1).toMatch(/\n\s*'version-skew' \{ return 2100 \}/);
    });

    it('runs the INSTALLED client programs, each from its own build folder, never this tree\'s Electron', () => {
        expect(row()).toContain("const clientProgram = (build) => join(CODE_ROOT, 'client', build, WIN ? 'genie-client.exe' : 'genie-client');");
        expect(row()).toMatch(/openClient\(\{ label: 'client-new-host-old',[^\n]*hostBuild: OLD, program: clientProgram\(NEW\) \}\)/);
        expect(row()).toMatch(/openClient\(\{ label: 'client-old-host-new',[^\n]*hostBuild: NEW, program: clientProgram\(OLD\) \}\)/);
        expect(row()).toMatch(/under\(executableOf\(newOld\.app\.pid\), join\(CODE_ROOT, 'client', NEW\)\)/);
        expect(row()).toMatch(/under\(executableOf\(oldNew\.app\.pid\), join\(CODE_ROOT, 'client', OLD\)\)/);
        expect(lib()).toMatch(/spawn\(program \?\? electronBinary\(\), argv,/);
        expect(lib()).toMatch(/const argv = \[\.\.\.\(program \? \[\] : \['\.'\]\),/);
    });

    it('streams a turn both ways in each pairing: asked from that client, every tick back into it, from a provider under that host', () => {
        expect(row()).toMatch(/await skewTurn\(newOld, '12',/);
        expect(row()).toMatch(/await skewTurn\(oldNew, '14',/);
        expect(row()).toMatch(/descends\(pid, host, parents\(\)\) && \/stub-codex\/\.test\(commandLine\(pid\)\)/);
        expect(row()).toMatch(/const gap = contiguous\(t\.ticks, 1, t\.max\);/);
        // The reverse pairing comes only after the host really is NEW, through its own drain and the launcher's swap.
        expect(row().indexOf("action: 'installHostUpdate'", row().indexOf('async function versionSkew'))).toBeLessThan(row().indexOf("label: 'client-old-host-new'"));
    });
});
