import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The renderer may only reach LEAF modules in `main/`.
 *
 * ## The incident
 *
 * `renderer/lib/genie.ts` grew `import type { AgentManagerState } from
 * '../../main/agents/agent-manager'` (Tynn #709). That module imports
 * `../terminal/ipc`, which imports `./genie-adapter` — code that SPAWNS CHILD
 * PROCESSES. `renderer/tsconfig.json` includes `./**\/*`, and TypeScript
 * type-checks every file a program reaches, so `genie-adapter.ts` landed inside
 * the renderer's compilation and its long-standing `spawn` typings failed it:
 *
 *     main/terminal/genie-adapter.ts(188,21): error TS2769: No overload matches…
 *     main/terminal/genie-adapter.ts(190,23): Property 'unref' does not exist…
 *     main/terminal/genie-adapter.ts(193,55): Property 'pid' does not exist…
 *
 * Three errors in a file nobody on that branch had opened. The compile failure
 * was the SYMPTOM; the defect was a hole in the main/renderer boundary — the
 * renderer could see process-spawning code at all.
 *
 * `import type` does NOT help. It governs what is EMITTED, not what is
 * COMPILED, which is exactly why the leak was invisible to review: every import
 * involved was already type-only.
 *
 * ## The rule
 *
 * A `main/` module the renderer imports must be a LEAF — no imports, or only
 * type-only imports of other leaves. That was already true of all seven modules
 * the renderer reached before #709; it was simply never written down, so there
 * was nothing to fail. This is that.
 *
 * Types the renderer needs live in a type-only module (`agents/agent-manager-types.ts`
 * is the one #709 added). VALUES cross by IPC, which is the boundary that
 * already exists.
 *
 * Source-level because that is what the rule is ABOUT — the import graph, not
 * anything observable at runtime. Precedent for the technique is
 * `agent-restart-gate.test.ts` next door.
 */

const RENDERER = path.resolve(__dirname, '../..');
const REPO = path.resolve(RENDERER, '..');

/** Every `.ts`/`.tsx` under `renderer/`, excluding build output. */
function rendererSources(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) rendererSources(full, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

/** Resolve an import specifier to a repo-relative path under `main/`, or null. */
function mainTargetOf(fromFile: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null;
    const resolved = path.resolve(path.dirname(fromFile), spec);
    const rel = path.relative(REPO, resolved).split(path.sep).join('/');
    return rel.startsWith('main/') ? rel : null;
}

const IMPORT_SPEC = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*'([^']+)'/g;

/** The import specifiers a file names. */
function importSpecs(file: string): string[] {
    const src = fs.readFileSync(file, 'utf8');
    return [...src.matchAll(IMPORT_SPEC)].map((m) => m[1]!);
}

/** Add the `.ts`/`.tsx` extension back onto a resolved module path. */
function sourceFileFor(repoRelative: string): string | null {
    for (const ext of ['.ts', '.tsx', '/index.ts']) {
        const candidate = path.join(REPO, repoRelative + ext);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

/** Every `main/` module the renderer names directly. */
function directMainImports(): Map<string, string[]> {
    const byTarget = new Map<string, string[]>();
    for (const file of rendererSources(RENDERER)) {
        for (const spec of importSpecs(file)) {
            const target = mainTargetOf(file, spec);
            if (!target) continue;
            const importers = byTarget.get(target) ?? [];
            importers.push(path.relative(REPO, file).split(path.sep).join('/'));
            byTarget.set(target, importers);
        }
    }
    return byTarget;
}

describe('the renderer → main boundary', () => {
    const direct = directMainImports();

    it('POSITIVE CONTROL: the scan actually finds the renderer’s main imports', () => {
        // Every assertion below is a `for` over this map. If the walk broke — a
        // renamed folder, a regex that stopped matching — the suite would go
        // silently green and guard nothing. This is the classic way a
        // source-level test rots, so pin that it found real, known edges.
        expect(direct.size).toBeGreaterThan(3);
        expect([...direct.keys()]).toContain('main/agents/registry');
        expect([...direct.keys()]).toContain('main/agents/agent-manager-types');
    });

    it('reaches only LEAF modules — nothing that imports a runtime dependency', () => {
        const offenders: string[] = [];
        for (const [target, importers] of direct) {
            const file = sourceFileFor(target);
            if (!file) {
                offenders.push(`${target} (imported by ${importers[0]}) does not resolve`);
                continue;
            }
            for (const spec of importSpecs(file)) {
                // A bare specifier is a package: `node:fs`, `electron`,
                // `better-sqlite3`. None of them belong in the renderer's
                // program, and each is a sign the module carries real work.
                if (!spec.startsWith('.')) {
                    offenders.push(
                        `${target} imports "${spec}" — it is not a leaf, so ` +
                            `${importers[0]} drags a runtime dependency into the ` +
                            `renderer's compilation. Move the types it needs into a ` +
                            `type-only module and import from there.`,
                    );
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('never reaches a spawning or database module, however INDIRECTLY', () => {
        // The specific class the incident was, and the one with teeth.
        //
        // TRANSITIVE on purpose. `genie-adapter.ts` was never NAMED by the
        // renderer -- it arrived three hops down (`agent-manager` ->
        // `terminal/ipc` -> `genie-adapter`), which is exactly why nobody caught
        // it in review. A direct-imports-only check stays green while the leak
        // is live; this walks the graph the compiler walks.
        const FORBIDDEN = /(^|\/)(db|ipc|background|genie-adapter|host-tools)$/;

        /** Every `main/` module reachable from the renderer, and the path in. */
        const reached = new Map<string, string>();
        const walk = (target: string, trail: string): void => {
            if (reached.has(target)) return;
            reached.set(target, trail);
            const file = sourceFileFor(target);
            if (!file) return;
            for (const spec of importSpecs(file)) {
                const next = mainTargetOf(file, spec);
                if (next) walk(next, `${trail} -> ${next}`);
            }
        };
        for (const [target, importers] of direct) {
            walk(target, `${importers[0]} -> ${target}`);
        }

        // The trail is the whole value of this test: it names every hop, so the
        // fix is obvious instead of archaeological.
        const offenders = [...reached.entries()]
            .filter(([target]) => FORBIDDEN.test(target))
            .map(([, trail]) => trail);
        expect(offenders).toEqual([]);

        // POSITIVE CONTROL: the walk really is transitive, and the pattern
        // really matches. Without these, a broken walk or a typo'd regex passes
        // forever -- and this is the assertion that would have caught #709's
        // leak, so it is the last one that may be allowed to rot.
        expect(reached.size).toBeGreaterThan(direct.size);
        expect(FORBIDDEN.test('main/terminal/genie-adapter')).toBe(true);
        expect(FORBIDDEN.test('main/agents/agent-manager-types')).toBe(false);
    });

    it('keeps agent-manager-types.ts itself importable — it has NO imports', () => {
        // The whole reason it exists. The moment it grows one, every renderer
        // file naming it inherits whatever that pulls in.
        const file = sourceFileFor('main/agents/agent-manager-types')!;
        expect(importSpecs(file)).toEqual([]);
    });

    it('the manager’s implementation modules stay OUT of the renderer', () => {
        // Named explicitly: these are the four #709 added, and the ones a future
        // edit would most plausibly reach for by reflex when adding a field.
        for (const impl of [
            'main/agents/agent-manager',
            'main/agents/agent-mcp',
            'main/agents/persona',
            'main/agents/sidecar-control',
        ]) {
            expect(
                direct.has(impl),
                `${impl} is imported by ${direct.get(impl)?.[0]} — import from ` +
                    'main/agents/agent-manager-types instead',
            ).toBe(false);
        }
    });
});
