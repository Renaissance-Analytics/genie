import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GENIE-HOST NEVER LOADS ELECTRON (the host split, phase 1). It runs as plain Node (`ELECTRON_RUN_AS_NODE=1`, later a
 * standalone runtime), where `import 'electron'` fails at start — and an Electron API reached from the host would tie the
 * agents back to the window. Every module the host entry reaches, by static import, is read here.
 *
 * P10.1b: genie-cloud runs the same bundle on PLAIN Node, where there is no Electron at all — so a DYNAMIC `import('…')` or
 * a `require('…')` counts too (it fails as surely, only later), and the walk follows dynamic relative imports. And no
 * `node-pty`: it is a native addon built for one runtime, and the host's terminals are its spawn-host children's
 * (main/spawn-host.ts, through fancy-term-host), never the host's own. The spawn host, which the host forks with the same
 * runtime, imports no Electron either.
 */

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
/** `import('x')` and `require('x')`: a module a runtime loads later, and fails to load as surely. */
const DYNAMIC = /\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;

function graph(entry: string): Map<string, string[]> {
    const seen = new Map<string, string[]>();
    const walk = (file: string): void => {
        if (seen.has(file)) return;
        const text = readFileSync(file, 'utf8');
        const specs: string[] = [];
        for (const m of text.matchAll(IMPORT)) {
            const spec = m[1] ?? m[2];
            if (spec) specs.push(spec);
        }
        for (const m of text.matchAll(DYNAMIC)) if (m[1]) specs.push(m[1]);
        seen.set(file, specs);
        for (const spec of specs) {
            if (!spec.startsWith('.')) continue;
            if (spec.includes('node_modules')) continue;
            walk(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
        }
    };
    walk(resolve(entry));
    return seen;
}

describe('genie-host\'s import graph', () => {
    const files = graph('src/main/genie-host.ts');

    it('reaches the session host and the engine server (positive control: the walk follows imports)', () => {
        const names = [...files.keys()].map((f) => f.replace(/\\/g, '/'));
        expect(names.some((f) => f.endsWith('src/main/session-host.ts'))).toBe(true);
        expect(names.some((f) => f.endsWith('src/core/session.ts'))).toBe(true);
        expect(names.some((f) => f.endsWith('src/main/session-engine-server.ts'))).toBe(true);
    });

    it('imports electron nowhere', () => {
        const offenders = [...files].filter(([, specs]) => specs.some((s) => s === 'electron' || s.startsWith('electron/'))).map(([f]) => f);
        expect(offenders).toEqual([]);
    });

    it('sees a dynamic import (positive control: keychain.ts loads @napi-rs/keyring with import())', () => {
        const keychain = [...files].find(([f]) => f.replace(/\\/g, '/').endsWith('src/main/keychain.ts'));
        expect(keychain?.[1]).toContain('@napi-rs/keyring');
    });

    it('loads no node-pty, nor fancy-term-host (which loads it): the host\'s terminals are its spawn-host children\'s', () => {
        const offenders = [...files].filter(([, specs]) => specs.some((s) => s === 'node-pty' || s === '@particle-academy/fancy-term-host')).map(([f]) => f);
        expect(offenders).toEqual([]);
    });
});

describe('the spawn host\'s import graph (forked by genie-host, with the same runtime)', () => {
    const files = graph('src/main/spawn-host.ts');

    it('reaches fancy-term-host (positive control: its terminals are there)', () => {
        expect([...files.values()].some((specs) => specs.includes('@particle-academy/fancy-term-host'))).toBe(true);
    });

    it('imports electron nowhere', () => {
        const offenders = [...files].filter(([, specs]) => specs.some((s) => s === 'electron' || s.startsWith('electron/'))).map(([f]) => f);
        expect(offenders).toEqual([]);
    });
});
