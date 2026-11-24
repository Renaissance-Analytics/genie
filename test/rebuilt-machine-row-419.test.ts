import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE REBUILT-MACHINE ROW IS IN THE GATE, ON BOTH PLATFORMS (the host split P7.3, Tynn #419). scripts/rebuilt-machine.mjs
 * starts a real genie-host on the real OS keychain, kills it mid-conversation, deletes the Machine files and the keychain
 * entries, and starts the same build on the State files. A row nobody runs proves nothing after today, so both CI
 * scripts name it, run that script, and give it what it needs: on Linux an unlocked Secret Service on its own session
 * bus (as the other keychain rows have), on Windows the test machine's session; and on Windows it ends its own
 * processes through scripts/end-own-tree.mjs, the one cleanup the row guard accepts.
 */

// The working tree's line ends are the machine's (CRLF on Windows): read as LF.
const read = (file: string): string => readFileSync(file, 'utf8').split(String.fromCharCode(13)).join('');
const linux = read('scripts/ci/linux.sh');
const windows = read('scripts/ci/windows.ps1');

describe('linux.sh', () => {
    const rows = linux.slice(linux.indexOf('ROWS=('), linux.indexOf('\n)\n', linux.indexOf('ROWS=(')));

    it('CONTROL: the slice is the row list', () => {
        expect(rows).toMatch(/\bdeps electron-binary\b/);
        expect(rows).toMatch(/\brenderer-crash\b/);
    });

    it('lists rebuilt-machine once, and runs the script with a keyring on its own session bus, under a deadline', () => {
        expect(rows.split(/\s+/).filter((r) => r === 'rebuilt-machine')).toHaveLength(1);
        expect(linux).toMatch(/\nrow_rebuilt-machine\(\) \{ need_install && need_keyring && timeout \d+ dbus-run-session -- bash scripts\/with-test-keyring\.sh node scripts\/rebuilt-machine\.mjs; \}\n/);
    });
});

describe('windows.ps1', () => {
    const rows = windows.slice(windows.indexOf('$Rows = @('), windows.indexOf('\n)\n', windows.indexOf('$Rows = @(')));

    it('CONTROL: the slice is the row list', () => {
        expect(rows).toContain("'deps', 'electron-binary'");
        expect(rows).toContain("'renderer-crash'");
    });

    it('lists rebuilt-machine once, and runs the script on the test machine', () => {
        expect(rows.split("'rebuilt-machine'")).toHaveLength(2);
        expect(windows).toMatch(/\nfunction Row-rebuilt-machine \{ Need-Install; Need-TestMachine; Run 'rebuilt-machine' \{ node scripts\/rebuilt-machine\.mjs \} \}\n/);
    });
});

describe('the row itself', () => {
    const row = read('scripts/rebuilt-machine-row.ts');

    it('refuses anywhere but a test machine, before it starts anything or touches the keychain', () => {
        const refusal = row.indexOf("console.error('refusing:");
        expect(refusal).toBeGreaterThan(0);
        expect(refusal).toBeLessThan(row.indexOf('AsyncEntry } = createRequire'));
        expect(refusal).toBeLessThan(row.indexOf('mkdtempSync(join(tmpdir()'));
    });

    it('on Windows its own processes are ended through end-own-tree.mjs, and what is left fails the row', () => {
        const cleanup = row.slice(row.indexOf('async function cleanup'), row.indexOf('const watchdog'));
        expect(cleanup).toMatch(/process\.platform === 'win32'[\s\S]{0,200}end-own-tree\.mjs/);
        expect(cleanup).toMatch(/endOwnRun\(\{ hostPid: [^}]*since: T0/);
        expect(cleanup).toMatch(/if \(!ended\.ok\) check\(false, 'nothing-left-running', ended\.words\)/);
        // And its keychain entries are forgotten whatever happened.
        expect(cleanup).toMatch(/for \(const \[name\] of SECRETS\) await forget\(name\)/);
    });

    it('the wrapper runs it through tsx and hands back its exit code', () => {
        const wrapper = read('scripts/rebuilt-machine.mjs');
        expect(wrapper).toMatch(/import\.meta\.resolve\('tsx'\), 'scripts\/rebuilt-machine-row\.ts'/);
        expect(wrapper).toMatch(/process\.exit\(ran\.status \?\? 1\)/);
    });
});
