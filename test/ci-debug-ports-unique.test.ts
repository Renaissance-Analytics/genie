import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linuxRow, linuxRows, windowsFunction, windowsRows } from './helpers/ci-scripts.js';

/*
 * EVERY ROW THAT OPENS ITS OWN GENIE HAS DEBUGGER PORTS OF ITS OWN (Tynn #1036 P6-1). The full gate 1124-034522-b451dd failed
 * linux/client-only-update: an earlier row's process still held 9222, the row's Genie logged "Cannot start http server for
 * devtools", and the row read the other app's page. A row's process that outlives it is exactly what a shared port turns
 * into the next row's failure, so no two rows name the same port, on either platform.
 *
 * A row's ports are the ones its body sets (CDP_PORT=9405, QUIT_CDP_INSPECT = '9415'), or else the ones the scripts it runs
 * name (their defaults). The shared app's rows (need_app, Need-App) drive the one app on 9222 by design: 9222 is that app's,
 * not theirs, and no row of its own may use it. esc-unsend-row-1029.test.ts holds the same rule for one script (#2137).
 */
const root = join(__dirname, '..');
const PORTS = /(?:PORT|INSPECT|[Pp]ort|[Ii]nspect)[A-Za-z_]*\s*[=:]\s*(?:Number\(process\.env\.[A-Z_]+ \?\? )?['"]?(\d{4,5})\b|remote-debugging-port=(\d{4,5})\b|--inspect=(?:127\.0\.0\.1:)?(\d{4,5})\b/g;
const SHARED_APP = 9222;

/** The debugger ports named in a text: 9200-9999, where every row's are. */
function portsIn(text: string): number[] {
    return [...new Set([...text.matchAll(PORTS)].map((m) => Number(m[1] ?? m[2] ?? m[3])).filter((p) => p >= 9200 && p <= 9999))];
}

/** A row's ports: its body's own, or else those of the scripts it runs; the shared app's port is not a shared-app row's. */
function rowPorts(body: string, readScript: (path: string) => string | null): number[] {
    const own = portsIn(body);
    const ports = own.length > 0 ? own : [...new Set([...body.matchAll(/scripts\/([\w./-]+\.(?:mjs|sh|ps1))/g)].flatMap((m) => portsIn(readScript(`scripts/${m[1]}`) ?? '')))];
    return /\bneed_app\b|\bNeed-App\b/.test(body) ? ports.filter((p) => p !== SHARED_APP) : ports;
}

/** Each port named by more than one row, with the rows. */
function shared(rows: ReadonlyArray<{ name: string; ports: readonly number[] }>): Array<{ port: number; rows: string[] }> {
    const by = new Map<number, string[]>();
    for (const r of rows) for (const p of r.ports) by.set(p, [...(by.get(p) ?? []), r.name]);
    return [...by].filter(([, names]) => new Set(names).size > 1).map(([port, names]) => ({ port, rows: [...new Set(names)] }));
}

const readScript = (path: string) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n') : null);
const linux = () => linuxRows.map((name) => ({ name, ports: rowPorts(linuxRow(name), readScript) }));
const windows = () => windowsRows.map((name) => ({ name, ports: rowPorts(windowsFunction(`Row-${name}`), readScript) }));

describe('the readers', () => {
    it('CONTROL: they find the ports the rows are known to use', () => {
        const l = new Map(linux().map((r) => [r.name, r.ports]));
        const w = new Map(windows().map((r) => [r.name, r.ports]));
        expect(l.get('sound-picker')).toEqual([9352]);
        expect(w.get('esc-unsend')).toEqual([9381, 9382]);
        // A port set in the row's body wins over the script's defaults.
        expect(l.get('quit-keeps-host')).not.toContain(9222);
        expect(l.get('quit-keeps-host')!.length).toBe(2);
        // The shared app's rows name no port of their own.
        expect(l.get('smoke')).toEqual([]);
        expect(w.get('layout')).toEqual([]);
    });

    it('CONTROL: two rows on one port are found, and a row on one port alone is not', () => {
        expect(shared([{ name: 'a', ports: [9300] }, { name: 'b', ports: [9300, 9301] }])).toEqual([{ port: 9300, rows: ['a', 'b'] }]);
        expect(shared([{ name: 'a', ports: [9300] }, { name: 'b', ports: [9301] }])).toEqual([]);
        expect(rowPorts('need_app && CDP_PORT=9222 node x', () => null)).toEqual([]);
        expect(rowPorts('need_build && node scripts/x.mjs', () => 'const PORT = Number(process.env.X ?? 9222);')).toEqual([9222]);
    });
});

describe('no two rows share a debugger port', () => {
    it('linux.sh', () => {
        expect(shared(linux())).toEqual([]);
    });

    it('windows.ps1', () => {
        expect(shared(windows())).toEqual([]);
    });

    it('no row of its own uses the shared app\'s 9222, and the client-only update row has one of its own on both', () => {
        for (const r of [...linux(), ...windows()]) expect(r.ports, r.name).not.toContain(SHARED_APP);
        expect(linux().find((r) => r.name === 'client-only-update')!.ports).toEqual([9401]);
        expect(windows().find((r) => r.name === 'client-only-update')!.ports).toEqual([9401]);
    });
});
