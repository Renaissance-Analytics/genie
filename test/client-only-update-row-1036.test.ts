import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linuxRow, linuxRows, linuxSh, windowsFunction, windowsPs1, windowsRows } from './helpers/ci-scripts.js';

/*
 * A CLIENT-ONLY UPDATE IS A CI ROW ON BOTH PLATFORMS, AND IT PROVES THE AGENT STREAMED THROUGH IT (Tynn #1036 P6-1).
 * scripts/vm-client-only-update.ps1 (Windows) and scripts/vm-client-only-update-linux.sh (Linux) install a build, update it
 * through the real updater to one that carries the same genie-host, while an agent streams, and check the same host and
 * provider pids after. "The same pid alive" is not a stream: the provider is the stub in TICKER mode (a marker file holding
 * the row script's pid), mid-turn when install is asked (update-cdp.mjs with UPDATE_TICKS_FILE), and a window of the new
 * build on the same host finds every tick streamed while there was no window in the agent's ledger, in order, from the
 * same provider pid (update-ticks-after-cdp.mjs, quit-keeps-host-cdp.mjs's gauge). Each is registered as other rows are:
 * listed, with its function and its ceiling (esc-unsend-row-1029.test.ts reads them the same way), last, because it
 * replaces the install, the home and the build that the rows before it read.
 */
const root = join(__dirname, '..');
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');
/** Without comment lines: a comment names nothing that runs. */
const code = (text: string, comment: RegExp) => text.split('\n').filter((l) => !comment.test(l)).join('\n');
const ps1 = () => code(read('scripts', 'vm-client-only-update.ps1'), /^\s*#/);
const sh = () => code(read('scripts', 'vm-client-only-update-linux.sh'), /^\s*#/);
const js = (file: string) => code(read('scripts', file), /^\s*(\/\/|\*|\/\*)/);

describe('registered as a row, last', () => {
    it('linux.sh: listed last, run with its own timeout under its ceiling, its leftovers reaped', () => {
        expect(linuxRows.at(-1)).toBe('client-only-update');
        expect(linuxRow('client-only-update')).toBe('row_client-only-update() { need_install && need_electron && need_display && timeout 2300 bash scripts/vm-client-only-update-linux.sh; }');
        expect(linuxSh).toMatch(/\n\s*client-only-update\) echo 2400 ;;/);
        expect(/case " ([^"\n]*) " in\n\s*\*" \$name "\*\) reap_leftovers "\$name" ;;/.exec(linuxSh)?.[1]?.split(' ')).toContain('client-only-update');
    });

    it('windows.ps1: listed last, its function, its ceiling', () => {
        expect(windowsRows.at(-1)).toBe('client-only-update');
        expect(windowsFunction('Row-client-only-update')).toBe("function Row-client-only-update { Need-Install; Need-Electron; Need-TestMachine; Run 'vm-client-only-update' { powershell -NoProfile -ExecutionPolicy Bypass -File scripts/vm-client-only-update.ps1 } }");
        expect(windowsPs1).toMatch(/\n\s*'client-only-update' \{ return 2400 \}/);
    });
});

describe('the agent streams through the install', () => {
    it('both rows switch the stub to its ticker by a marker holding the row script’s own pid, and name the ledger file', () => {
        expect(ps1()).toMatch(/\$ticker = Join-Path \(\[System\.IO\.Path\]::GetTempPath\(\)\) 'genie-stub-codex-ticker'/);
        expect(ps1()).toMatch(/Set-Content -Path \$ticker -Value "\$PID"/);
        expect(ps1()).toMatch(/\$env:UPDATE_TICKS_FILE = /);
        expect(sh()).toMatch(/TICKER="\$\(node -p 'require\("os"\)\.tmpdir\(\)'\)\/genie-stub-codex-ticker"/);
        expect(sh()).toMatch(/printf '%s' "\$\$" >"\$TICKER"/);
        expect(sh()).toMatch(/export UPDATE_TICKS_FILE=/);
        expect(read('scripts', 'stub-codex.mjs')).toContain("join(tmpdir(), 'genie-stub-codex-ticker')");
    });

    it('update-cdp.mjs puts the agent mid-turn and writes where its ledger stood when install was asked', () => {
        const cdp = js('update-cdp.mjs');
        expect(cdp).toMatch(/const ticksFile = process\.env\.UPDATE_TICKS_FILE;/);
        expect(cdp).toMatch(/prompt\(\$\{JSON\.stringify\(codexId\)\}, 'Stream ticks until stopped\.'\)/);
        expect(cdp).toMatch(/writeFileSync\(ticksFile, JSON\.stringify\(\{ agentId: codexId, pid: [^}]*max: [^}]*askedAt: Date\.now\(\) \}\)\);/);
        // Written before install is asked: the window goes with the install.
        expect(cdp.indexOf('writeFileSync(ticksFile')).toBeLessThan(cdp.indexOf("window.genieTest.updates.install()"));
    });

    it('both rows read the ledger again in a window of the new build, and fail when it did not stream through', () => {
        expect(ps1()).toMatch(/node scripts\\update-ticks-after-cdp\.mjs[\s\S]{0,80}\n\s*if \(\$LASTEXITCODE -ne 0\) \{ throw "the agent's stream did not run through the install/);
        expect(sh()).toMatch(/node scripts\/update-ticks-after-cdp\.mjs \|\| \{ [^}]*fail "the agent's stream did not run through the install"; \}/);
        // Before the pids are compared: the stream is the row's first word on the agent.
        expect(ps1().indexOf('update-ticks-after-cdp.mjs')).toBeLessThan(ps1().indexOf('genie-host changed:'));
        expect(sh().indexOf('update-ticks-after-cdp.mjs')).toBeLessThan(sh().indexOf('genie-host changed:'));
    });

    it('the ledger check: running, the same provider pid alive, grown, and no tick missing since install was asked', () => {
        const after = js('update-ticks-after-cdp.mjs');
        expect(after).toMatch(/check\(after\.running === true, /);
        expect(after).toMatch(/after\.pids\.length === 1 && after\.pids\[0\] === before\.pid && alive\(before\.pid\)/);
        expect(after).toMatch(/after\.max - before\.max >= wanted/);
        expect(after).toMatch(/const gap = contiguous\(numbers, before\.max \+ 1, after\.max\);/);
        expect(after).toMatch(/process\.exit\(failures\.length === 0 \? 0 : 1\);/);
    });

    it('the gap gauge is quit-keeps-host-cdp.mjs’s, shared from crash-cdp-lib.mjs', () => {
        expect(js('crash-cdp-lib.mjs')).toMatch(/export const contiguous = \(ticks, from, to\) => \{ for \(let n = from; n <= to; n\+\+\) if \(!ticks\.has\(n\)\) return n; return null; \};/);
        expect(js('update-ticks-after-cdp.mjs')).toMatch(/import \{ alive, Cdp, check, contiguous, failures, ticksOf, until \} from '\.\/crash-cdp-lib\.mjs';/);
    });

    it('the break probe ends the provider during the install, in both rows', () => {
        expect(ps1()).toMatch(/\$break = if \(\$env:UPDATE_TICKS_BREAK\) \{ \$env:UPDATE_TICKS_BREAK \} elseif \(Test-Path \$breakFile\)/);
        expect(ps1()).toMatch(/if \(\$break -eq 'stop-provider'\) \{[\s\S]{0,500}Stop-Process -Id \$s\.ProcessId -Force/);
        expect(sh()).toMatch(/if \[ "\$\{UPDATE_TICKS_BREAK:-\}" = stop-provider \]; then\n\s*for p in \$stubs_before; do [^\n]*kill -9 "\$p"/);
    });
});

describe('what the row starts, it ends', () => {
    it('Windows: through scripts/end-own-tree.mjs, at the teardown and after a failure', () => {
        expect(ps1()).toMatch(/node scripts\/end-own-tree\.mjs --since "\$\(\$script:began\)" --tree "\$\(\$script:viewer\.Id\)" --root "\$\(\$hostAfter\.Id\)"/);
        expect(ps1()).toMatch(/if \(\$script:began -and -not \$script:ended\) \{[\s\S]*node scripts\/end-own-tree\.mjs @endArgs/);
        expect(ps1()).not.toMatch(/Kill-Tree \$hostAfter\.Id/);
    });

    it('Linux: its exit trap ends its windows, genie-host and the providers, pass or fail', () => {
        expect(sh()).toMatch(/cleanup\(\) \{\n(?:[^\n]*\n)*?\s*end_all\n/);
        expect(sh()).toMatch(/trap cleanup EXIT/);
    });
});
