import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { runShuttle, shuttleOptionsFromEnv, SHUTTLE_EXIT } from '../entry';
import { shuttleControlPath, type RunningShuttle, type StartShuttleResult } from '../shuttle';

/**
 * HOW THE SHUTTLE PROCESS STARTS, AND WHAT IT TELLS WHOEVER STARTED IT.
 *
 * genie#346 Phase 1. Genie spawns the shuttle detached, on the shipped standalone
 * Node, so everything it needs arrives in the environment and everything Genie
 * needs back comes out as ONE line on stdout and an exit code. Genie decides from
 * that line whether to attach or fall back in-process (§3.3, §9.2), so each outcome
 * has to be told apart without parsing prose.
 */

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function stateDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-shuttle-entry-'));
    dirs.push(dir);
    return dir;
}

const env = (dir: string, over: Record<string, string | undefined> = {}) => ({
    GENIE_SHUTTLE_STATE_DIR: dir,
    GENIE_SHUTTLE_PORT: '51717',
    GENIE_SHUTTLE_WIRE_GENERATION: '3',
    GENIE_SHUTTLE_VERSION: '0.7.0-beta.324',
    ...over,
});

function io() {
    const lines: string[] = [];
    let signal: (() => void) | null = null;
    const exited: number[] = [];
    return {
        lines,
        exited,
        fire: () => signal?.(),
        io: {
            write: (line: string) => void lines.push(line),
            onSignal: (handler: () => void) => void (signal = handler),
            exit: (code: number) => void exited.push(code),
        },
    };
}

const until = async (check: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 5));
    }
};

describe('shuttleOptionsFromEnv', () => {
    it('builds the options from the environment Genie spawns it with', () => {
        const dir = stateDir();

        const parsed = shuttleOptionsFromEnv(env(dir));

        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.options).toMatchObject({
            port: 51717,
            stateDir: dir,
            controlPath: shuttleControlPath(dir),
            wireGeneration: 3,
            shuttleVersion: '0.7.0-beta.324',
        });
        // The same secret Genie reads, from the same file.
        expect(parsed.options.secret).toBe(fs.readFileSync(path.join(dir, 'publisher.secret'), 'utf8'));
    });

    it.each([
        ['GENIE_SHUTTLE_STATE_DIR', undefined],
        ['GENIE_SHUTTLE_PORT', 'eighty'],
        ['GENIE_SHUTTLE_PORT', '70000'],
        ['GENIE_SHUTTLE_WIRE_GENERATION', '1.5'],
        ['GENIE_SHUTTLE_VERSION', ''],
    ])('names %s when it is %s', (name, value) => {
        const parsed = shuttleOptionsFromEnv(env(stateDir(), { [name]: value }));

        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.error).toContain(name);
    });
});

describe('runShuttle', () => {
    it('announces a start in one line, and closes cleanly on a signal', async () => {
        const dir = stateDir();
        const close = vi.fn(async () => {});
        const shuttle = { port: 51717, controlPath: 'ctl', state: () => 'detached', close } as unknown as RunningShuttle;
        const t = io();

        await runShuttle(env(dir), { ...t.io, start: async () => ({ ok: true, shuttle }) });

        expect(t.lines).toHaveLength(1);
        expect(JSON.parse(t.lines[0]!)).toMatchObject({ event: 'started', port: 51717, controlPath: 'ctl', pid: process.pid });
        expect(t.exited).toEqual([]);

        t.fire();
        await until(() => t.exited.length > 0);
        expect(close).toHaveBeenCalledOnce();
        expect(t.exited).toEqual([SHUTTLE_EXIT.ok]);
    });

    it('reports a REFUSAL with its reason and its own exit code', async () => {
        // Genie falls back in-process on this, and must be able to tell "the port
        // is someone else's" from "a shuttle is already running — attach to it".
        const t = io();
        const refused: StartShuttleResult = { ok: false, reason: 'control-in-use', error: 'Another MCP shuttle…' };

        await runShuttle(env(stateDir()), { ...t.io, start: async () => refused });

        expect(JSON.parse(t.lines[0]!)).toMatchObject({ event: 'refused', reason: 'control-in-use' });
        expect(t.exited).toEqual([SHUTTLE_EXIT.refused]);
    });

    it('reports a bad environment without trying to start', async () => {
        const t = io();
        const start = vi.fn();

        await runShuttle(env(stateDir(), { GENIE_SHUTTLE_PORT: 'nope' }), { ...t.io, start });

        expect(start).not.toHaveBeenCalled();
        expect(JSON.parse(t.lines[0]!)).toMatchObject({ event: 'invalid' });
        expect(t.exited).toEqual([SHUTTLE_EXIT.invalid]);
    });

    it('gives the three outcomes three different exit codes', () => {
        expect(new Set(Object.values(SHUTTLE_EXIT)).size).toBe(3);
    });
});

describe('the shuttle bundle runs on plain Node', () => {
    /**
     * The shuttle runs on the shipped standalone Node, never Electron — that is
     * what lets it outlive an upgrade (§3.2). Plain Node has no `electron` module
     * and no app `node_modules`, so a single import of either anywhere in the
     * shuttle's graph is a process that dies at start, and only on a real machine.
     */
    function importGraph(entry: string): { files: string[]; external: string[] } {
        const seen = new Set<string>();
        const external = new Set<string>();
        const visit = (file: string) => {
            if (seen.has(file)) return;
            seen.add(file);
            const source = fs.readFileSync(file, 'utf8');
            for (const m of source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
                const spec = m[1]!;
                if (!spec.startsWith('.')) {
                    external.add(spec);
                    continue;
                }
                const base = path.resolve(path.dirname(file), spec);
                const resolved = [`${base}.ts`, path.join(base, 'index.ts')].find((f) => fs.existsSync(f));
                if (!resolved) throw new Error(`cannot resolve ${spec} from ${file}`);
                visit(resolved);
            }
        };
        visit(entry);
        return { files: [...seen], external: [...external] };
    }

    it('imports nothing but Node built-ins and its own files', () => {
        const graph = importGraph(path.resolve(__dirname, '../main.ts'));

        // POSITIVE CONTROL: the walk really reached the shuttle, not just the entry.
        expect(graph.files.some((f) => f.endsWith(path.join('mcp-shuttle', 'listener.ts')))).toBe(true);
        expect(graph.external.filter((s) => !builtinModules.includes(s.replace(/^node:/, '')))).toEqual([]);
    });
});
