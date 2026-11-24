import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linuxRow, linuxRows, linuxSh, windowsFunction, windowsPs1, windowsRows } from './helpers/ci-scripts.js';

/*
 * A HOST UPDATE DRAINS AND SWAPS, PROVEN BY A REAL ROW ON BOTH PLATFORMS (Tynn #1036 P6-2, task #1499).
 * scripts/vm-windows-update.ps1 (Windows) and scripts/vm-host-update-linux.sh (Linux) install a build and update it through
 * the real updater to one that carries ANOTHER genie-host: the update's build is made with GENIE_TEST_HOST_MARK set, a define
 * in host.js only (vite.main.config.ts, as __GENIE_TEST_HOLDS__; nothing that ships sets it), so its host bundle's hash
 * differs and the feed names that hash. The row, with an agent running when install is asked:
 *
 *   the host logged a full install ("this host exits"); the drain recorded the agent in running-at-quit.json before the old
 *   host was gone; the old genie-host and every provider from before are gone; a NEW genie-host runs the update's host
 *   (its host.js is under ~/.genie/host/<the update's hash>/, its binary the copied runtime, and it logs the update's mark);
 *   the base's copy is gone; and the agent came back exactly once, under the new host.
 *
 * Two break probes (HOST_UPDATE_BREAK, or host-update-break.txt: In-Session passes no environment): `client-only` builds the
 * update with no mark (the same host), and the row must fail on the kept host; `drop-restore` empties the drain's record
 * while the installer runs, and the row must fail on the agent that did not come back.
 */
const root = join(__dirname, '..');
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');
/** Without comment lines: a comment names nothing that runs. */
const code = (text: string, comment: RegExp) => text.split('\n').filter((l) => !comment.test(l)).join('\n');
const ps1 = () => code(read('scripts', 'vm-windows-update.ps1'), /^\s*#/);
const sh = () => code(read('scripts', 'vm-host-update-linux.sh'), /^\s*#/);
const both = () => [['windows', ps1()], ['linux', sh()]] as const;

describe('registered as a row, last, after client-only-update', () => {
    it('linux.sh: host-update last, client-only-update just before it, its own timeout under its ceiling, leftovers reaped', () => {
        expect(linuxRows.slice(-2)).toEqual(['client-only-update', 'host-update']);
        expect(linuxRow('host-update')).toBe('row_host-update() { need_install && need_electron && need_display && timeout 2300 bash scripts/vm-host-update-linux.sh; }');
        expect(linuxSh).toMatch(/\n\s*host-update\) echo 2400 ;;/);
        expect(/case " ([^"\n]*) " in\n\s*\*" \$name "\*\) reap_leftovers "\$name" ;;/.exec(linuxSh)?.[1]?.split(' ')).toContain('host-update');
    });

    it('windows.ps1: host-update last, client-only-update just before it, its function, its ceiling', () => {
        expect(windowsRows.slice(-2)).toEqual(['client-only-update', 'host-update']);
        expect(windowsFunction('Row-host-update')).toBe("function Row-host-update { Need-Install; Need-Electron; Need-TestMachine; Run 'vm-windows-update' { powershell -NoProfile -ExecutionPolicy Bypass -File scripts/vm-windows-update.ps1 } }");
        expect(windowsPs1).toMatch(/\n\s*'host-update' \{ return 2400 \}/);
    });
});

describe('the update carries another genie-host', () => {
    it('the build mark is a define of the main bundle, from GENIE_TEST_HOST_MARK, empty unless a row sets it', () => {
        expect(read('vite.main.config.ts')).toMatch(/__GENIE_TEST_HOST_MARK__: JSON\.stringify\(process\.env\.GENIE_TEST_HOST_MARK \?\? ''\)/);
    });

    it('genie-host says its mark when it has one, so the row can tell which host code runs', () => {
        const host = read('src', 'main', 'genie-host.ts');
        // Through `typeof`: the tests run genie-host.ts from source (tsx), where nothing defines it.
        expect(host).toMatch(/declare const __GENIE_TEST_HOST_MARK__: string \| undefined;/);
        expect(host).toMatch(/const hostMark = typeof __GENIE_TEST_HOST_MARK__ === 'string' \? __GENIE_TEST_HOST_MARK__ : '';/);
        expect(host).toMatch(/if \(hostMark !== ''\) lifecycleLog\(`host build mark: \$\{hostMark\}`\);/);
    });

    it('both rows build the update with the mark, stop when the hosts are the same, and have the feed name the update’s host', () => {
        expect(ps1()).toMatch(/\$env:GENIE_TEST_HOST_MARK = \$mark\n\s*Run 'npm run build' 'build-next\.log'/);
        expect(ps1()).toMatch(/if \(\$nextHostHash -eq \$baseHostHash -and \$break -ne 'client-only'\) \{ Write-Output '### host-update=NOT-A-HOST-UPDATE'/);
        expect(ps1()).toMatch(/if \(\$latest -notmatch "genieHostHash: '\$nextHostHash'"\) \{ throw/);
        expect(sh()).toMatch(/GENIE_TEST_HOST_MARK="\$MARK" run build-next\.log npm run build/);
        expect(sh()).toMatch(/if \[ "\$NEXT_HASH" = "\$BASE_HASH" \] && \[ "\$BREAK" != client-only \]; then echo '### host-update=NOT-A-HOST-UPDATE'/);
        expect(sh()).toMatch(/grep -q "genieHostHash: '\$NEXT_HASH'" release\/latest-linux\.yml \|\| fail/);
        // The base is built with no mark: GENIE_TEST_HOST_MARK is cleared before it.
        expect(ps1().indexOf("Remove-Item Env:GENIE_TEST_HOST_MARK")).toBeLessThan(ps1().indexOf("'build-current.log'"));
        expect(sh()).toMatch(/unset GENIE_TEST_HOST_MARK\n[\s\S]*run build-base\.log npm run build/);
    });

    it('the client-only break probe builds the update with no mark', () => {
        expect(ps1()).toMatch(/\$mark = if \(\$break -eq 'client-only'\) \{ '' \} else \{ "host-update-\$Next" \}/);
        expect(sh()).toMatch(/if \[ "\$BREAK" = client-only \]; then MARK=''; else MARK="host-update-\$NEXT"; fi/);
    });
});

describe('the mark never reaches a build that ships', () => {
    /** Every file under these roots, as paths relative to the checkout with forward slashes. */
    const files = (...roots: string[]): string[] => roots.flatMap((r) => {
        const at = join(root, r);
        if (statSync(at, { throwIfNoEntry: false })?.isFile()) return [r];
        if (!statSync(at, { throwIfNoEntry: false })?.isDirectory()) return [];
        const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
            d.isDirectory() ? walk(join(dir, d.name)) : d.isFile() ? [relative(root, join(dir, d.name)).split('\\').join('/')] : []);
        return walk(at);
    });
    /** The environment variable by name (not the define, __GENIE_TEST_HOST_MARK__). */
    const ENV_NAME = /(?<![A-Z_])GENIE_TEST_HOST_MARK(?![A-Z_])/;

    it('only vite.main.config.ts and the two row scripts name it: no workflow, CI runner, packaging config or source sets it', () => {
        const naming = files('scripts', '.github', 'src', 'package.json', 'electron-builder.yml', 'vite.main.config.ts')
            .filter((f) => ENV_NAME.test(readFileSync(join(root, f), 'utf8')));
        expect(naming.sort()).toEqual(['scripts/vm-host-update-linux.sh', 'scripts/vm-windows-update.ps1', 'vite.main.config.ts']);
        // CONTROL: the search reaches the workflows and the CI runners it clears.
        expect(files('.github')).toContain('.github/workflows/release.yml');
        expect(files('scripts')).toEqual(expect.arrayContaining(['scripts/ci/linux.sh', 'scripts/ci/windows.ps1']));
    });

    describe('the main bundle’s define', () => {
        const saved = process.env.GENIE_TEST_HOST_MARK;
        afterEach(() => { if (saved === undefined) delete process.env.GENIE_TEST_HOST_MARK; else process.env.GENIE_TEST_HOST_MARK = saved; vi.resetModules(); });
        const define = async (): Promise<Record<string, string>> => {
            vi.resetModules();
            const config = (await import('../vite.main.config.ts')).default as { define: Record<string, string> };
            return config.define;
        };

        it('with nothing set, as every build that ships is made, the mark is the empty string', async () => {
            delete process.env.GENIE_TEST_HOST_MARK;
            expect((await define()).__GENIE_TEST_HOST_MARK__).toBe('""');
        });

        it('CONTROL: set, it is that string', async () => {
            process.env.GENIE_TEST_HOST_MARK = 'host-update-9.9.9';
            expect((await define()).__GENIE_TEST_HOST_MARK__).toBe('"host-update-9.9.9"');
        });
    });

    it('both rows prove it on a real build: the base (no mark) has none in host.js, the update’s has its own (the control)', () => {
        expect(ps1()).toMatch(/if \(Select-String -Path 'dist\\main\\host\.js' -Pattern 'host-update-' -SimpleMatch -Quiet\) \{ throw 'the base build, made with no mark/);
        expect(ps1()).toMatch(/if \(\$mark -and -not \(Select-String -Path 'dist\\main\\host\.js' -Pattern \$mark -SimpleMatch -Quiet\)\) \{ throw/);
        expect(sh()).toMatch(/grep -qF 'host-update-' dist\/main\/host\.js && fail 'the base build, made with no mark/);
        expect(sh()).toMatch(/if \[ -n "\$MARK" \] && ! grep -qF "\$MARK" dist\/main\/host\.js; then fail/);
        // Checked on the base's own build, before the update's replaces dist/.
        expect(ps1().indexOf("-Pattern 'host-update-'")).toBeLessThan(ps1().indexOf("'build-next.log'"));
        expect(sh().indexOf("grep -qF 'host-update-'")).toBeLessThan(sh().indexOf('run build-next.log'));
    });
});

describe('the row: drained, swapped, restored once', () => {
    it('the base host runs from its copy under the base’s hash, before anything is asked', () => {
        expect(ps1()).toMatch(/if \(\$hostBeforeLine -notlike "\*\\host\\\$baseHostHash\\dist\\main\\host\.js\*"\) \{ throw/);
        expect(sh()).toMatch(/case "\$host_before_cmd" in \*"\/host\/\$BASE_HASH\/dist\/main\/host\.js"\*\) ;; \*\) fail/);
    });

    it('the host logged a full install', () => {
        for (const [, s] of both()) expect(s).toContain("'updater: it has the install; this host exits'");
    });

    it('the drain recorded the agent in running-at-quit.json once the old host was gone, before the relaunch', () => {
        // Read by node, one id a line: PowerShell 5.1's ConvertFrom-Json reads `[]` as one item (RULES.md, the one-as-nothing gauge).
        expect(ps1()).toMatch(/function Json-Ids\(\$file\) \{[^\n]*JSON\.parse\(require\('fs'\)\.readFileSync\(process\.argv\[1\], 'utf8'\)\)\) console\.log\(id\)/);
        expect(ps1()).toMatch(/\$atQuit = @\(Json-Ids \$runningAtQuit\)/);
        expect(ps1()).not.toMatch(/ConvertFrom-Json\)\.Count|\| ConvertFrom-Json\)\n/);
        expect(ps1()).toMatch(/if \(\$atQuit\.Count -lt 1\) \{ throw 'the drain recorded no agent to come back/);
        expect(sh()).toMatch(/ids_in\(\) \{ node -e '[^\n]*JSON\.parse\(require\("fs"\)\.readFileSync\(process\.argv\[1\], "utf8"\)\)\.length/);
        expect(sh()).toMatch(/at_quit="\$\(ids_in "\$RUNNING_AT_QUIT"\)"/);
        expect(sh()).toMatch(/\[ "\$at_quit" -ge 1 \] \|\| fail 'the drain recorded no agent to come back/);
        // Read when the old host is gone, before the installer has finished.
        expect(ps1().indexOf('$atQuit = @(')).toBeLessThan(ps1().indexOf('Installed-Version\n'));
        expect(sh().indexOf('at_quit="$(')).toBeLessThan(sh().indexOf('replaced=\'\''));
    });

    it('the old host and every provider from before are gone; a NEW host runs the update’s copy and says its mark', () => {
        expect(ps1()).toMatch(/if \(\$hostAfter\.Id -eq \$hostBefore\.Id\) \{ throw "genie-host is still pid/);
        expect(ps1()).toMatch(/if \(Get-Process -Id \$hostBefore\.Id -ErrorAction SilentlyContinue\) \{ throw "the old genie-host/);
        expect(ps1()).toMatch(/if \(\$hostAfterLine -notlike "\*\\host\\\$nextHostHash\\dist\\main\\host\.js\*"\) \{ throw/);
        expect(ps1()).toMatch(/if \(\$hostAfterExe -notlike "\$genieHome\\host\\runtime-\*-host\\genie-host\.exe"\) \{ throw/);
        expect(ps1()).toMatch(/-Pattern "host build mark: \$mark"/);
        expect(ps1()).toMatch(/if \(Test-Path \(Join-Path \$genieHome "host\\\$baseHostHash"\)\) \{ throw/);
        expect(sh()).toMatch(/\[ "\$host_after" != "\$host_before" \] \|\| fail "genie-host is still pid/);
        expect(sh()).toMatch(/alive "\$host_before" && fail "the old genie-host/);
        expect(sh()).toMatch(/case "\$host_after_cmd" in \*"\/host\/\$NEXT_HASH\/dist\/main\/host\.js"\*\) ;; \*\) fail/);
        expect(sh()).toMatch(/case "\$host_after_exe" in "\$GHOME"\/host\/runtime-\*-host\/genie-host\) ;; \*\) fail/);
        expect(sh()).toMatch(/grep -q "host build mark: \$MARK" "\$GHOME\/runtime\/lifecycle\.log" \|\| fail/);
        expect(sh()).toMatch(/\[ -e "\$GHOME\/host\/\$BASE_HASH" \] && fail/);
    });

    it('the agent came back exactly once, under the new host; no provider from before survived', () => {
        // Found by its script, whatever runs it: the provider runs under genie-host's own executable as Node, never node.exe.
        expect(ps1()).not.toMatch(/stub-codex\.mjs\*' -and \$_\.Name -eq 'node\.exe'/);
        expect(ps1()).toMatch(/if \(\$survivors\.Count -ne 0\) \{/);
        expect(ps1()).toMatch(/if \(\$revived\.Count -ne 1\) \{ throw "the agent that was running came back \$\(\$revived\.Count\) times/);
        expect(ps1()).toMatch(/if \(-not \(Descends \$revived\[0\]\.ProcessId \$hostAfter\.Id\)\) \{ throw/);
        expect(sh()).toMatch(/for p in \$stubs_before; do alive "\$p" && fail "agent provider pid \$p survived the update"; done/);
        expect(sh()).toMatch(/\[ "\$revived_n" -eq 1 \] \|\| fail "the agent that was running came back \$revived_n times/);
        expect(sh()).toMatch(/descends "\$revived" "\$host_after" \|\| fail/);
    });

    it('the drop-restore break probe empties the drain’s record after the old host is gone', () => {
        expect(ps1()).toMatch(/if \(\$break -eq 'drop-restore'\) \{[^}]*Set-Content -Path \$runningAtQuit -Value '\[\]'/);
        expect(sh()).toMatch(/if \[ "\$BREAK" = drop-restore \]; then [^\n]*printf '\[\]' >"\$RUNNING_AT_QUIT"/);
        expect(ps1().indexOf("$break -eq 'drop-restore'")).toBeGreaterThan(ps1().indexOf('$atQuit = @('));
        expect(sh().indexOf('"$BREAK" = drop-restore')).toBeGreaterThan(sh().indexOf('at_quit="$('));
    });

    it('both rows read the break from the environment or a file at the root', () => {
        expect(ps1()).toMatch(/\$break = if \(\$env:HOST_UPDATE_BREAK\) \{ \$env:HOST_UPDATE_BREAK \} elseif \(Test-Path \$breakFile\)/);
        expect(sh()).toMatch(/BREAK="\$\{HOST_UPDATE_BREAK:-\}"\n\[ -z "\$BREAK" \] && \[ -f host-update-break\.txt \] && BREAK=/);
    });
});

describe('a debugger port of its own, its own launch, and its own end', () => {
    it('port 9416, refused when something already answers on it, the launch pid handed to the driver', () => {
        expect(ps1()).toMatch(/\$debugPort = 9416\n\$env:CDP_PORT = "\$debugPort"/);
        expect(ps1()).toMatch(/Assert-PortFree\n\s*\$app = Start-Process -FilePath \$exe -ArgumentList "--remote-debugging-port=\$debugPort"/);
        expect(ps1()).toMatch(/\$env:CDP_OWN_PID = "\$\(\$app\.Id\)"\n\s*& cmd \/c "node scripts\\update-cdp\.mjs 2>&1"/);
        expect(sh()).toMatch(/DEBUG_PORT=9416\nexport CDP_PORT="\$DEBUG_PORT"/);
        expect(sh()).toMatch(/port_free\n"\$APPIMAGE_FILE" --remote-debugging-port="\$DEBUG_PORT"/);
        // The driver needs the version it is to find (1124-071406-5b696f: without it, exit 2 before anything was asked).
        expect(sh()).toMatch(/EXPECT_VERSION="\$NEXT" CDP_OWN_PID="\$APP_PID" node scripts\/update-cdp\.mjs/);
        expect(ps1()).toMatch(/\$env:EXPECT_VERSION = \$Next\n/);
    });

    it('Windows: no pty helper from before outlives the update, wherever it runs (not the install dir: since the host split it is the host copy)', () => {
        expect(ps1()).toMatch(/Remove-Item Env:EXPECT_HELPERS -ErrorAction SilentlyContinue/);
        expect(ps1()).not.toMatch(/\$env:EXPECT_HELPERS = '1'/);
        expect(ps1()).toMatch(/\$helpersBefore = @\(Get-CimInstance Win32_Process \| Where-Object \{ \$_\.Name -like 'fancy-pty-helper\*' \}/);
        expect(ps1()).toMatch(/\$helpers = @\(Get-CimInstance Win32_Process \| Where-Object \{ \$_\.Name -like 'fancy-pty-helper\*' -and \$helpersBefore -contains \[int\]\$_\.ProcessId \}\)/);
        expect(ps1().indexOf('$helpersBefore = @(')).toBeLessThan(ps1().indexOf("Step 'the drain"));
    });

    it('the seed runs in a new workspace, never the checkout', () => {
        expect(ps1()).toMatch(/Push-Location \$workspace\n\s*try \{ & node \(Join-Path \$root 'scripts\\smoke-seed\.mjs'\)/);
        expect(ps1()).not.toMatch(/Run 'node scripts\\smoke-seed\.mjs'/);
        expect(sh()).toMatch(/\( cd "\$WORKSPACE" && node "\$ROOT\/scripts\/smoke-seed\.mjs" \) >seed\.log 2>&1/);
    });

    it('Windows ends what it started through end-own-tree.mjs, pass or fail', () => {
        expect(ps1()).toMatch(/node scripts\/end-own-tree\.mjs --since "\$\(\$script:began\)"/);
        expect(ps1()).toMatch(/if \(\$script:began -and -not \$script:ended\) \{[\s\S]{0,600}node scripts\/end-own-tree\.mjs @endArgs/);
    });

    it('both print their pass marker last', () => {
        expect(ps1()).toMatch(/Write-Output "### host-update=PASS"\n\} finally \{/);
        expect(sh()).toMatch(/echo '### host-update=PASS'\n?$/);
    });
});
