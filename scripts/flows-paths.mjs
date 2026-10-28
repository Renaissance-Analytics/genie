#!/usr/bin/env node
/**
 * WHAT FLOWS ARE MADE OF — the files whose change can change how Flows behave, derived from the code's own imports.
 *
 * CI's `flows acceptance` job runs `npm run verify:flows` only when a change touches Flows (the owner, 2026-10-27: not
 * part of the full suite, "only when we make changes to flows"). It used to decide that by file NAME — anything with
 * "flow" in it — and so genie#1302 reached the flow editor window through `src/core/address.ts`, the renderer's route
 * table, and the job never ran. The answer is the import graph, walked here on the commit being tested, so the set cannot
 * drift from the code: a new module a flow file imports is in it the moment the import is written.
 *
 * The set is:
 *  1. ENTRIES — every file under src/ whose name says flow (new flow modules join by being named so), and the files the
 *     flow editor window's route goes through, which import no flow file and no flow file imports (WINDOW_PATH below).
 *  2. Everything the entries import at RUN TIME, transitively. `import type` / `export type … from` are left out: they
 *     cannot change what a flow does, and following them reaches half the app through shared port types. (Typecheck
 *     covers them on every PR anyway.)
 *  3. The WIRING — each file that imports a flow file at run time (compose.ts, feature-ipc.ts, main.ts, App.tsx, the MCP
 *     registrations…). The file itself, not what it imports: these are the app's hubs, and their own imports are the
 *     whole of Genie. They are where Flows are plugged in, so a change to them can unplug Flows.
 *
 * Plus the suite itself, its config and this script. `test/flows-acceptance-ci.test.ts` holds every rule here.
 *
 * Usage:
 *   node scripts/flows-paths.mjs                      the set, one path per line
 *   node scripts/flows-paths.mjs --touched <file>     of the paths listed in <file> (one per line, as `git diff --name-only`
 *                                                     prints them), the ones that touch Flows; nothing when none do
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A file under src/ whose name says flow: flow-runner.ts, v1-flows.ts, mcp-tools-flows.ts, FlowEditorWindow.tsx… */
export const FLOW_NAME = /^src\/(.*\/)?[^/]*[Ff]low[^/]*$/;

/**
 * THE FLOW EDITOR WINDOW'S PATH — read from main.ts's `openFlowEditorWindow` and App.tsx's route resolution. The window is
 * `index.html#genie://flow/<id>`; none of these files is a flow module and none is imported by one, so the graph alone
 * cannot find them. Each must still handle the flow route (the test checks), so this list cannot quietly go stale.
 */
export const WINDOW_PATH = [
    // isInternalRoute / routeOfAddress / addressOf: whether `genie://flow/<id>` is read as a route at all (genie#1302).
    'src/core/address.ts',
    // parseRoute: `genie://flow/<id>` → the 'flow' surface App.tsx renders as the canvas.
    'src/core/route.ts',
    // windowLabelOf: the window is labelled 'flow', the label main's open request carries.
    'src/core/window-activation.ts',
    // viewReaches: a navigation reaches the main window only, never a flow editor (#1302 follow-up, #1312).
    'src/core/view-requests.ts',
    // The window's preload (`preload.cjs`): the bridge the editor's load, save and run go through.
    'src/main/preload.ts',
];

/** Not under src/, and Flows all the same. A prefix ending in / is a directory. */
export const ALSO = ['test/flows-acceptance/', 'vitest.flows.config.mts', 'scripts/flows-paths.mjs'];

/** Every .ts / .tsx file under src/, as a repo-relative POSIX path. */
export function srcFiles(root = REPO) {
    const out = [];
    const walk = (dir) => {
        for (const name of readdirSync(join(root, dir))) {
            const path = `${dir}/${name}`;
            if (statSync(join(root, path)).isDirectory()) walk(path);
            else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
        }
    };
    walk('src');
    return out.sort();
}

// `import … from 'x'`, `export … from 'x'`, `import 'x'`, `import('x')` — but not `import type` / `export type … from`.
// Comments are not stripped: an import written in a comment adds an edge, which only ever makes the set larger.
const IMPORT = /\b(?:import|export)\s+(?!type\s)(?:[^'"`;]*?\s+from\s+)?['"]([^'"\n]+)['"]|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g;

/**
 * The run-time imports of one file that are files of this repository's src/: `resolved` (repo-relative paths) and
 * `unresolved` (a relative specifier into src/ that names no file — the walker would be blind there, so the test fails).
 */
export function runtimeImports(file, root = REPO) {
    const text = readFileSync(join(root, file), 'utf8');
    const resolved = new Set();
    const unresolved = [];
    for (const m of text.matchAll(IMPORT)) {
        const spec = m[1] ?? m[2];
        if (!spec.startsWith('.')) continue;
        const target = posix.normalize(posix.join(posix.dirname(file), spec));
        if (!target.startsWith('src/')) continue;
        if (/\.(css|svg|png|jpe?g|gif|webp|woff2?|json|html|md|txt)(\?.*)?$/.test(target)) continue;
        const base = target.replace(/\.(js|jsx|ts|tsx|mjs)$/, '');
        const hit = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((c) => existsSync(join(root, c)));
        if (hit) resolved.add(hit);
        else unresolved.push(`${file} → ${spec}`);
    }
    return { resolved: [...resolved], unresolved };
}

/** src/'s run-time import graph: file → the src files it imports. */
export function importGraph(root = REPO) {
    return new Map(srcFiles(root).map((f) => [f, runtimeImports(f, root).resolved]));
}

/** THE SET: the files under src/ a change to which can change how Flows behave (see the top of this file). Sorted. */
export function flowsDependencySet(root = REPO) {
    const graph = importGraph(root);
    const files = [...graph.keys()];
    const flowFiles = files.filter((f) => FLOW_NAME.test(f));
    const entries = [...flowFiles, ...WINDOW_PATH.filter((f) => graph.has(f))];
    const set = new Set(entries);
    const queue = [...entries];
    while (queue.length) {
        for (const dep of graph.get(queue.pop()) ?? []) {
            if (!set.has(dep)) { set.add(dep); queue.push(dep); }
        }
    }
    const flowSet = new Set(flowFiles);
    for (const f of files) if (graph.get(f).some((dep) => flowSet.has(dep))) set.add(f);
    return [...set].sort();
}

/**
 * Of the changed paths, the ones that touch Flows: in the set, under ALSO, or named as a flow file (a DELETED flow file is
 * in no graph — the commit that deletes it still touches Flows).
 */
export function touchedFlows(changed, root = REPO) {
    const set = new Set(flowsDependencySet(root));
    return changed
        .map((p) => p.trim())
        .filter((p) => p && (set.has(p) || FLOW_NAME.test(p) || ALSO.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a))));
}

// Run as a script (not imported by the test): by name, since comparing full paths trips over a drive letter's case.
if (/(^|[\\/])flows-paths\.mjs$/.test(process.argv[1] ?? '')) {
    const [flag, list] = process.argv.slice(2);
    if (flag === '--touched') {
        if (!list) { console.error('usage: flows-paths.mjs --touched <file of changed paths>'); process.exit(2); }
        const hits = touchedFlows(readFileSync(list, 'utf8').split(/\r?\n/));
        if (hits.length) console.log(hits.join('\n'));
    } else if (flag === undefined) {
        console.log(flowsDependencySet().join('\n'));
    } else {
        console.error(`unknown argument ${flag}`);
        process.exit(2);
    }
}
