import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GENIE-HOST NEVER LOADS ELECTRON (the host split, phase 1). It runs as plain Node (`ELECTRON_RUN_AS_NODE=1`, later a
 * standalone runtime), where `import 'electron'` fails at start — and an Electron API reached from the host would tie the
 * agents back to the window. Every module the host entry reaches, by static import, is read here.
 */

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

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
});
