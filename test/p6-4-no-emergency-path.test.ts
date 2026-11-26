import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * HOST SPLIT P6-4 (Tynn #1036, task #1500): THE WINDOW HAS NO EMERGENCY PATH. A window with no host shows the host
 * directory (main.ts `openHostDirectory`, Tynn #415, #1815, #1058 L4); it never runs agents, flows, sites, stores or terminals itself. The
 * code that let it (the window's own wake, compose's replica branches and safe-mode inputs, the no-host plugins stand-in)
 * reached nothing: main does not compose, and the tests compose alone. It is deleted, and this file keeps it deleted.
 *
 * 1. main.ts's RUNTIME import closure holds none of the modules that do host work. Read transitively, not one file deep:
 *    a helper that imports the composition would bring it into the window as surely as main importing it. Type-only
 *    imports are not followed: they compile to nothing.
 * 2. What the emergency path was made of is gone, and no source file describes it as if it were there.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

/** The relative imports a file runs: static, dynamic and side-effect imports and re-exports; `import type` / `export type` dropped. */
export function runtimeImports(text: string): string[] {
    const runtime = text.replace(/^\s*(?:import|export)\s+type\s[^;]*?from\s*['"][^'"]+['"];?/gms, '');
    return [...runtime.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.[^'"]+)['"]/g)].map((m) => m[1]!);
}

function resolveImport(spec: string, from: string): string | null {
    const base = resolve(dirname(resolve(root, from)), spec);
    const stem = base.replace(/\.(m?js|cjs|jsx)$/, '');
    for (const candidate of [stem + '.ts', stem + '.tsx', base, join(base, 'index.ts')]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return relative(root, candidate).replace(/\\/g, '/');
    }
    return null;
}

/** Every source file `entry` runs, transitively (src/ only: packages are their own). `extra` lays more text over a file. */
export function runtimeClosure(entry: string, extra: Readonly<Record<string, string>> = {}): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length > 0) {
        const file = stack.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const text = read(file) + (extra[file] ?? '');
        for (const spec of runtimeImports(text)) {
            const target = resolveImport(spec, file);
            if (target?.startsWith('src/')) stack.push(target);
        }
    }
    return seen;
}

/** The modules that DO host work: stores, flows, the supervisor, ptys, hosting, plugins, MCP, remote access. genie-host's. */
const HOST_WORK = [
    'hosting-compose', 'hosting-trust', 'site-manager', 'service-registry', 'gen-router-server', 'dotenv-sync', 'host-keychain',
    'agent-stores-open', 'settings-store', 'inbox-store', 'attention-store', 'knowledge-store',
    'flows-engine', 'flow-scheduler', 'process-supervisor', 'process-book', 'terminal-host',
    'plugin-host', 'mcp-server', 'remote-access-host',
].map((name) => `src/main/${name}.ts`);
/** The spawn host's own pty engine: its child's, never the window's. */
const PTY_ENGINE = ['src/main/spawn-host.ts', 'src/main/fancy-term-port.ts'];

describe('1. the window runs no host work: main.ts’s runtime closure holds none of it', () => {
    const main = runtimeClosure('src/main/main.ts');

    it('no composition: not compose.ts (the tests’), not genie-host’s hosting, stores, flows, supervisor, ptys, plugins, MCP or remote access', () => {
        expect(HOST_WORK.filter((file) => main.has(file))).toEqual([]);
        expect(main.has('src/main/compose.ts')).toBe(false);
        expect(PTY_ENGINE.filter((file) => main.has(file))).toEqual([]);
    });

    it('CONTROL: the same gauge finds every one of them where it runs (genie-host, the spawn host), and reads main transitively', () => {
        const host = runtimeClosure('src/main/genie-host.ts');
        expect(HOST_WORK.filter((file) => !host.has(file))).toEqual([]);
        const spawn = runtimeClosure('src/main/spawn-host.ts');
        expect(PTY_ENGINE.filter((file) => !spawn.has(file))).toEqual([]);
        // A direct import of main's, and one main imports for its types only and runs through another file
        // (main → agent-engine.ts → session-engine-client.ts).
        expect(main.has('src/main/window-safe-mode.ts')).toBe(true);
        expect(main.has('src/main/session-engine-client.ts')).toBe(true);
        expect(code(read('src/main/main.ts'))).toMatch(/import type \{ SessionEngineClient \} from '\.\/session-engine-client\.js'/);
        expect(code(read('src/main/main.ts'))).not.toMatch(/import \{[^}]*\bSessionEngineClient\b[^}]*\} from '\.\/session-engine-client\.js'/);
        expect(main.size).toBeGreaterThan(200);
    });

    it('CONTROL: an import of host work, direct or through a helper, is caught; a type-only one is not followed', () => {
        expect(runtimeClosure('src/main/main.ts', { 'src/main/main.ts': "\nimport { composeWith } from './compose.js';\n" }).has('src/main/compose.ts')).toBe(true);
        expect(runtimeClosure('src/main/main.ts', { 'src/main/window-safe-mode.ts': "\nconst p = await import('./process-supervisor.js');\n" }).has('src/main/process-supervisor.ts')).toBe(true);
        expect(runtimeClosure('src/main/main.ts', { 'src/main/main.ts': "\nimport type { SettingsStore } from './settings-store.js';\n" }).has('src/main/settings-store.ts')).toBe(false);
        expect(runtimeImports("import { a, type B } from './x.js';\nexport { c } from './y.js';\nimport './z.js';")).toEqual(['./x.js', './y.js', './z.js']);
    });
});

describe('2. the emergency path is gone', () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const path = join(dir, e.name);
        return e.isDirectory() ? files(path) : /\.(ts|tsx)$/.test(e.name) ? [relative(root, path).replace(/\\/g, '/')] : [];
    });
    const sources = files(resolve(root, 'src'));
    const block = (text: string, head: string): string => {
        const start = text.indexOf(head);
        expect(start, head).toBeGreaterThanOrEqual(0);
        let depth = 0;
        for (let i = text.indexOf('{', start); i < text.length; i += 1) {
            if (text[i] === '{') depth += 1;
            else if (text[i] === '}' && (depth -= 1) === 0) return text.slice(start, i + 1);
        }
        return text.slice(start);
    };

    it('the window’s own wake is deleted, and nothing names it', () => {
        expect(existsSync(resolve(root, 'src/main/window-wake.ts'))).toBe(false);
        expect(sources.filter((f) => /\bwindowWake\b|window-wake/.test(read(f)))).toEqual([]);
    });

    it('compose (the tests’ composition) takes no host replica of the stores or flows, and no window safe mode', () => {
        const input = code(block(read('src/main/compose.ts'), 'export interface ComposeInput'));
        for (const field of ['agentStores', 'flowsEngine', 'safeMode', 'heldSite', 'safeModeLeft']) expect(input, field).not.toMatch(new RegExp(`readonly ${field}\\??:`));
        // It always opens its own: what it opens is required.
        expect(input).toMatch(/readonly alone: ComposeAlone;/);
        // CONTROL: the block read is the real one.
        expect(input).toMatch(/readonly userData: string;/);
    });

    it('a composition holds no `own` / `ownFlows` copy of what it opened, and no window has a no-host plugins stand-in', () => {
        const composed = code(block(read('src/main/host-services.ts'), 'export interface ComposedServices'));
        expect(composed).not.toMatch(/readonly own(Flows)?:/);
        expect(composed).toMatch(/readonly inbox:/);
        expect(code(read('src/main/plugins-replica.ts'))).not.toMatch(/\bNO_PLUGINS\b/);
        expect(code(read('src/main/plugins-replica.ts'))).toMatch(/export class PluginsReplica\b/);
    });

    const describesIt = (text: string) => /emergency (no-host )?path|emergency in-process|no-host path/i.test(text);

    it('no source file, comments included, describes a no-host path as if the window had one', () => {
        expect(sources.filter((f) => describesIt(read(f)))).toEqual([]);
    });

    it('CONTROL: the wording gauge reads every source file and catches each way it was said', () => {
        expect(sources).toContain('src/main/main.ts');
        expect(sources.length).toBeGreaterThan(300);
        for (const said of ['only on the emergency path', 'the emergency no-host path', 'the EMERGENCY in-process engine', 'null when this window keeps one session (the no-host path)']) expect(describesIt(said), said).toBe(true);
        expect(describesIt('a window with no host stops')).toBe(false);
    });
});
