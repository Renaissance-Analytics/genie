import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linuxRow, linuxRows, linuxSh, windowsFunction, windowsPs1, windowsRows } from './helpers/ci-scripts.js';
import { descends } from '../scripts/cdp-own-launch.mjs';

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

describe('registered as a row: the launcher’s since L6 (Tynn #1058)', () => {
    /*
     * The spec's "What the CI rows become": client-only-update keeps its name and its assertions (the same host and provider
     * pids, the ticks streamed through), driven by the launcher from a local feed of signed manifests. The electron-updater
     * scripts below stay on disk for the bridge release (L9), which electron-updater still installs, and no row runs them.
     */
    it('linux.sh: before host-update and its rollback and the launcher’s own update, run by launcher-updates-row.mjs', () => {
        expect(linuxRows.slice(-5)).toEqual(['client-only-update', 'host-update', 'host-update-rollback', 'launcher-self-update', 'version-skew']);
        expect(linuxRow('client-only-update')).toBe('row_client-only-update() { need_build && need_tracks && need_display && on_display timeout 1320 env LAUNCHER_ROW_OUT="$OUT/client-only-update" LAUNCHER_ROW_KEY_DIR="$SETUP" CDP_PORT=9401 LAUNCHER_ROW_DEADLINE_MS=1200000 node scripts/launcher-updates-row.mjs --row client-only-update; }');
        expect(linuxSh).toMatch(/\n\s*client-only-update\|host-update\|host-update-rollback\) echo 1500 ;;/);
        expect(/case " ([^"\n]*) " in\n\s*\*" \$name "\*\) reap_leftovers "\$name" ;;/.exec(linuxSh)?.[1]?.split(' ')).toContain('client-only-update');
        expect(linuxSh).not.toContain('vm-client-only-update-linux.sh');
    });

    it('windows.ps1: the same order, its function, its ceiling; the old script is run by no row', () => {
        expect(windowsRows.slice(-5)).toEqual(['client-only-update', 'host-update', 'host-update-rollback', 'launcher-self-update', 'version-skew']);
        expect(windowsPs1).toContain("function Row-client-only-update {\n    Need-Build; Need-Tracks; Need-TestMachine\n    Invoke-LauncherUpdatesRow 'client-only-update' @{ LAUNCHER_ROW_OUT = (Join-Path $Out 'client-only-update'); LAUNCHER_ROW_KEY_DIR = $Setup; CDP_PORT = '9401'; LAUNCHER_ROW_DEADLINE_MS = '1620000' }\n}");
        expect(windowsPs1).toMatch(/\n\s*\{ \$_ -in 'client-only-update', 'host-update', 'host-update-rollback' \} \{ return 1800 \}/);
        expect(windowsPs1).not.toContain('vm-client-only-update.ps1');
    });

    it('the launcher’s row keeps the row’s promise: the same host and provider pids, every tick in order, the next window new', () => {
        const row = js('launcher-updates-row.mjs');
        expect(row).toMatch(/const gap = contiguous\(after\.ticks, ag\.before\.max \+ 1, after\.max\);/);
        expect(row).toContain("'--row'");
        for (const name of ['client-only-update', 'host-update', 'host-update-rollback', 'launcher-self-update']) expect(row).toContain(`'${name}'`);
    });
});

/* THE BRIDGE RELEASE'S SCRIPTS (L9): what follows proves the electron-updater scripts, kept for the bridge, as they were. */
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

describe('the seed never touches the checkout', () => {
    // The full gate 1124-020718-168937: in a shard, earlier rows have seeded the checkout and changed its project.json, and a
    // second seed of it is refused ("seed refuses to overwrite <checkout>/project.json"). So the row's workspace is a fresh
    // directory of its own, as quit-keeps-host's own home is (smoke-seed.mjs takes its cwd as the workspace).
    it('Windows: smoke-seed.mjs runs from a new workspace directory, never from the checkout', () => {
        expect(ps1()).toMatch(/\$workspace = Join-Path \(\[System\.IO\.Path\]::GetTempPath\(\)\) \("genie-update-workspace-" \+ \$PID\)/);
        expect(ps1()).toMatch(/Push-Location \$workspace\n\s*try \{ & node \(Join-Path \$root 'scripts\\smoke-seed\.mjs'\)/);
        expect(ps1()).not.toMatch(/Run 'node scripts\\smoke-seed\.mjs'/);
    });

    it('Linux: smoke-seed.mjs runs from a new workspace directory, never from the checkout', () => {
        expect(sh()).toMatch(/WORKSPACE="\$\(mktemp -d -t genie-update-workspace-XXXXXX\)"/);
        expect(sh()).toMatch(/\( cd "\$WORKSPACE" && node "\$ROOT\/scripts\/smoke-seed\.mjs" \) >seed\.log 2>&1/);
        expect(sh()).not.toMatch(/run seed\.log node scripts\/smoke-seed\.mjs/);
    });
});

describe('the page it drives is its own launch', () => {
    // The full gate 1124-034522-b451dd: an earlier row's process held 9222 and the row read that app's page. The row has a
    // port of its own (test/ci-debug-ports-unique.test.ts), refuses one that already answers, and its drivers check that the
    // process listening there is the launch it names (CDP_OWN_PID) or one it started.
    it('both scripts: port 9401, refused when something already answers on it, the launch pid handed to each driver', () => {
        expect(ps1()).toMatch(/\$debugPort = 9401\n\$env:CDP_PORT = "\$debugPort"/);
        expect(ps1()).toMatch(/if \(\$answered\) \{ throw "something already answers on this row's debugger port \$debugPort/);
        expect(ps1().match(/Assert-PortFree\n\s*(?:\$app|\$script:viewer) = Start-Process -FilePath \$exe -ArgumentList "--remote-debugging-port=\$debugPort"/g)?.length).toBe(2);
        expect(ps1()).toMatch(/\$env:CDP_OWN_PID = "\$\(\$app\.Id\)"\n\s*& cmd \/c "node scripts\\update-cdp\.mjs 2>&1"/);
        expect(ps1()).toMatch(/\$env:CDP_OWN_PID = "\$\(\$script:viewer\.Id\)"\n\s*& cmd \/c "node scripts\\update-ticks-after-cdp\.mjs 2>&1"/);
        expect(sh()).toMatch(/DEBUG_PORT=9401\nexport CDP_PORT="\$DEBUG_PORT"/);
        expect(sh().match(/port_free\n"\$APPIMAGE_FILE" --remote-debugging-port="\$DEBUG_PORT"/g)?.length).toBe(2);
        expect(sh()).toMatch(/CDP_OWN_PID="\$APP_PID" node scripts\/update-cdp\.mjs/);
        expect(sh()).toMatch(/CDP_OWN_PID="\$VIEWER_PID" node scripts\/update-ticks-after-cdp\.mjs/);
        for (const text of [ps1(), sh()]) expect(text).not.toMatch(/remote-debugging-port=9222/);
    });

    it('both drivers refuse a page that is not that launch, before reading it', () => {
        const cdp = js('update-cdp.mjs');
        expect(cdp).toMatch(/if \(process\.env\.CDP_OWN_PID\) \{\n\s*const why = notOwnLaunch\(PORT, Number\(process\.env\.CDP_OWN_PID\)\);[\s\S]{0,300}if \(why !== null\) \{[^\n]*process\.exit\(1\); \}/);
        expect(cdp.indexOf('notOwnLaunch(PORT')).toBeLessThan(cdp.indexOf('Cdp.connect(page.webSocketDebuggerUrl)'));
        const after = js('update-ticks-after-cdp.mjs');
        expect(after).toMatch(/const why = notOwnLaunch\(PORT, Number\(process\.env\.CDP_OWN_PID\)\);\n\s*if \(!check\(why === null, [^\n]*\)\) throw new Error/);
        expect(after.indexOf('notOwnLaunch(PORT')).toBeLessThan(after.indexOf('Cdp.connect(page.webSocketDebuggerUrl'));
    });

    it('own means the launch or a process it started, by the process table, never anything else on the port', () => {
        const parent = new Map([[30, 20], [20, 10], [10, 1], [40, 1]]);
        const parentOf = (pid: number) => parent.get(pid) ?? null;
        expect(descends(10, 10, parentOf)).toBe(true);
        expect(descends(30, 10, parentOf)).toBe(true);
        expect(descends(40, 10, parentOf)).toBe(false);
        expect(descends(30, 99, parentOf)).toBe(false);
        // A table with a loop answers, and answers no.
        expect(descends(5, 10, (pid) => (pid === 5 ? 6 : 5))).toBe(false);
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
