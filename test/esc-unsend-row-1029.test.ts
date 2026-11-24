import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * THE ESC-UNSEND PROOF IS A CI ROW ON BOTH PLATFORMS (Tynn #1029). scripts/esc-unsend-cdp.mjs was written, listed in
 * test/cdp-main-window.test.ts, and run by nothing: a proof nobody runs is not a proof. A row is registered in four
 * places in scripts/ci/linux.sh (the ROWS list, its row_ function, its ceiling, the leftovers it is reaped of) and three
 * in scripts/ci/windows.ps1 ($Rows, its Row- function, its Ceiling). Each is read here the same way for `sound-picker`
 * first: the control that this reads a registered row as registered.
 *
 * And the script runs where a row runs: nothing of it is a Linux-only path, the stub's record is in the run's own folder,
 * it starts on any test machine (GENIE_TEST_MACHINE, which both row scripts declare), and its debugger ports are no
 * other script's.
 */
const root = join(__dirname, '..');
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf8').split(/\r?\n/);
/** Without comment lines: a comment naming a row registers nothing. */
const linux = read('scripts', 'ci', 'linux.sh').filter((l) => !/^\s*#/.test(l)).join('\n');
const windows = read('scripts', 'ci', 'windows.ps1').filter((l) => !/^\s*#/.test(l)).join('\n');
const code = (file: string) => read('scripts', file).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const linuxRows = () => (/^ROWS=\(\n([\s\S]*?)\n\)/m.exec(linux)?.[1] ?? '').split(/\s+/).filter(Boolean);
const linuxRow = (name: string) => new RegExp(`^row_${name}\\(\\) \\{ ([^\\n]*) \\}$`, 'm').exec(linux)?.[1] ?? null;
const linuxCeiling = (name: string) => {
    const body = /^ceiling\(\) \{\n([\s\S]*?)\n\}/m.exec(linux)?.[1] ?? '';
    for (const line of body.split('\n')) {
        const m = /^\s*([a-z0-9|-]+)\) echo (\d+) ;;/.exec(line);
        if (m && m[1]!.split('|').includes(name)) return Number(m[2]);
    }
    return null;
};
const linuxReaped = () => (/case " ([^"\n]*) " in\n\s*\*" \$name "\*\) reap_leftovers "\$name" ;;/.exec(linux)?.[1] ?? '').split(' ').filter(Boolean);

const windowsRows = () => [...(/^\$Rows = @\(\n([\s\S]*?)\n\)/m.exec(windows)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);
const windowsRow = (name: string) => new RegExp(`^function Row-${name} \\{ ([^\\n]*) \\}$`, 'm').exec(windows)?.[1] ?? null;
const windowsCeiling = (name: string) => {
    const body = /^function Ceiling\(\[string\]\$name\) \{\n([\s\S]*?)\n\}/m.exec(windows)?.[1] ?? '';
    for (const line of body.split('\n')) {
        const m = /^\s*(?:'([^']+)'|\{ \$_ -in ([^}]*) \}) \{ return (\d+) \}/.exec(line);
        if (!m) continue;
        const names = m[1] !== undefined ? [m[1]] : [...m[2]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
        if (names.includes(name)) return Number(m[3]);
    }
    return null;
};

describe.each(['sound-picker', 'esc-unsend'])('the %s row (sound-picker is the control)', (name) => {
    it('linux.sh: listed, with its function, its ceiling, and its leftovers reaped', () => {
        expect(linuxRows()).toContain(name);
        expect(linuxRow(name)).toBe(`need_build && need_display && on_display timeout 240 node scripts/${name}-cdp.mjs;`);
        expect(linuxCeiling(name)).toBe(300);
        expect(linuxReaped()).toContain(name);
    });

    it('windows.ps1: listed, with its function and its ceiling', () => {
        expect(windowsRows()).toContain(name);
        expect(windowsRow(name)).toBe(`Need-Build; Need-TestMachine; Run '${name}-cdp' { node scripts/${name}-cdp.mjs }`);
        expect(windowsCeiling(name)).toBe(300);
    });
});

describe('the readers above', () => {
    it('CONTROL: a row that is not one reads as not registered, everywhere', () => {
        expect(linuxRows().length).toBeGreaterThan(20);
        expect(windowsRows().length).toBeGreaterThan(20);
        expect(linuxReaped().length).toBeGreaterThan(10);
        expect(linuxRows()).not.toContain('no-such-row');
        expect(linuxRow('no-such-row')).toBeNull();
        expect(linuxCeiling('no-such-row')).toBeNull();
        expect(linuxReaped()).not.toContain('no-such-row');
        expect(windowsRows()).not.toContain('no-such-row');
        expect(windowsRow('no-such-row')).toBeNull();
        expect(windowsCeiling('no-such-row')).toBeNull();
        // A grouped ceiling is read too (linux `a|b)`, windows `{ $_ -in 'a', 'b' }`).
        expect(linuxCeiling('smoke')).toBe(360);
        expect(windowsCeiling('smoke')).toBe(360);
    });
});

describe('scripts/esc-unsend-cdp.mjs runs where a row runs', () => {
    const row = code('esc-unsend-cdp.mjs');
    const stub = code('esc-unsend-stub-claude.mjs');

    it('holds no Linux-only path: the stub writes its record beside itself, in the run\'s own folder', () => {
        expect(row).not.toMatch(/['"`]\/tmp\//);
        expect(stub).not.toMatch(/['"`]\/tmp\//);
        // The stub is copied into the run's folder and writes beside itself (prism-acp hands it a filtered environment,
        // so the place cannot be a variable); the row reads the same file.
        expect(stub).toMatch(/const RECEIVED = join\(dirname\(fileURLToPath\(import\.meta\.url\)\), 'esc-unsend-received\.jsonl'\);/);
        expect(row).toMatch(/copyFileSync\(resolve\('scripts\/esc-unsend-stub-claude\.mjs'\), stub\)/);
        expect(row).toMatch(/RECEIVED = join\(root, 'esc-unsend-received\.jsonl'\)/);
    });

    it('starts on a test machine as both row scripts declare one, and nowhere else', () => {
        expect(linux).toMatch(/export GENIE_TEST_MACHINE=1/);
        expect(windows).toMatch(/\$env:GENIE_TEST_MACHINE = '1'/);
        expect(row).toMatch(/demand\(process\.env\.CI === 'true' \|\| process\.env\.GENIE_TEST_MACHINE === '1', 'refused: run only in CI or a test VM'\)/);
    });

    it('takes What\'s new off the page with the shared helper, as every row that clicks does', () => {
        expect(row).toMatch(/from '\.\/cdp-whats-new\.mjs'/);
        expect(row).toMatch(/closeWhatsNew\(/);
    });

    it('its debugger ports are no other script\'s', () => {
        const m = /PORT = (\d{4,5}), INSPECT = (\d{4,5})/.exec(row);
        expect(m).not.toBeNull();
        const mine = [m![1]!, m![2]!];
        expect(new Set(mine).size).toBe(2);
        const scripts = join(root, 'scripts');
        const files = readdirSync(scripts, { recursive: true, encoding: 'utf8' })
            .filter((f) => /\.(mjs|cjs|js|sh|ps1)$/.test(f) && !/esc-unsend-cdp\.mjs$/.test(f));
        // CONTROL: the sweep reads the other rows' ports (sound-picker's is 9352).
        expect(files.some((f) => /\b9352\b/.test(readFileSync(join(scripts, f), 'utf8')))).toBe(true);
        const taken = files.filter((f) => mine.some((port) => new RegExp(`\\b${port}\\b`).test(readFileSync(join(scripts, f), 'utf8'))));
        expect(taken).toEqual([]);
    });
});
