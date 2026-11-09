import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeServices } from './helpers/compose-alone.js';
import { type ComposedServices } from '../src/main/compose.js';
import { writeAgentProtocol, type SyncFs } from '../src/main/config-sync-targets.js';
import { writeGenieInstructions } from '../src/main/genie-instructions.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import type { TynnSessionPort } from '../src/main/tynn-agent-token.js';

/**
 * THE TYNN WORK MODEL IN THE PROTOCOL GENIE WRITES (Tynn story #402; the owner, 2026-11-07: "genie needs to be built to
 * optimize work management for users to track and agents to follow so everyone stays in alignment. That is the whole
 * purpose of Tynn ... file based PM is a fallback, not the goto").
 *
 * Signed in to tynn.ai, `.agents/_genie/shared.md` tells every agent how work runs in Tynn — a release is a version; a
 * story is one PR and its tasks are that PR's plan; items move through the workflow as work happens; a go request lists
 * what is NOT in the build; local plan files are only a fallback — points to the Tynn tools for planning and progress,
 * and to Tynn's own `tynn-guidelines` resource, which carries Tynn's canonical text (tynn.ai#441). Not signed in, it says
 * the work lives in local plan files, and that this is the fallback. Read from the files Genie actually writes.
 */
function memFs() {
    const store = new Map<string, string>();
    const fs: SyncFs = {
        read: async (p) => store.get(p) ?? null,
        write: async (p, t) => { store.set(p, t); },
        remove: async (p) => { store.delete(p); },
        list: async (dir) => [...store.keys()].filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/')).map((k) => k.slice(dir.length + 1)),
    };
    return { fs, store };
}
const W = '/w/example';
const SHARED = `${W}/.agents/_genie/shared.md`;
const tools = [{ name: 'imDone', description: 'x' }];

/** Tynn's work model, statement by statement, as the protocol must carry it when signed in. */
const MODEL: ReadonlyArray<[string, RegExp]> = [
    ['a release is a version', /release is a version/i],
    ['a story is one PR, its tasks are the plan', /story is one PR[^.\n]*tasks are that PR['’]s plan/i],
    ['items move through the workflow as work happens', /through `workflow` as work happens/],
    ['a go request lists what is NOT in the build', /go request lists what is NOT in/],
    ['local plan files are only a fallback', /local plan files are only a fallback/i],
];
const FALLBACK = /not signed in to Tynn[\s\S]*local plan files[\s\S]*fallback/i;

describe('the protocol Genie writes', () => {
    it('signed in to tynn.ai: the Tynn work model, the Tynn tools for planning and progress, and Tynn\'s own guidelines', async () => {
        const { fs, store } = memFs();
        await writeAgentProtocol({ workspacePath: W, fs, enabled: true, tools, tracking: 'tynn' });
        const md = store.get(SHARED)!;
        for (const [what, pattern] of MODEL) expect(md, what).toMatch(pattern);
        expect(md).toMatch(/`tynn` MCP tools[\s\S]*`next`[\s\S]*`workflow`/);
        expect(md).toContain('`tynn-guidelines`');
        expect(md).not.toMatch(FALLBACK);
    });

    it('not signed in: the work lives in local plan files, and the protocol says that is the fallback', async () => {
        const { fs, store } = memFs();
        await writeAgentProtocol({ workspacePath: W, fs, enabled: true, tools, tracking: 'files' });
        const md = store.get(SHARED)!;
        expect(md).toMatch(FALLBACK);
        expect(md).toContain('.ai/plans/');
        expect(md).not.toMatch(/story is one PR/i);
        expect(md).not.toContain('`tynn-guidelines`');
        // Left unsaid, a sync writes the fallback: Genie never claims Tynn it was not told about.
        const unsaid = memFs();
        await writeAgentProtocol({ workspacePath: W, fs: unsaid.fs, enabled: true, tools });
        expect(unsaid.store.get(SHARED)).toBe(md);
    });

    it('signing in or out changes the file on the next sync, and a sync that changes nothing writes nothing', async () => {
        const { fs, store } = memFs();
        await writeAgentProtocol({ workspacePath: W, fs, enabled: true, tools, tracking: 'files' });
        const before = store.get(SHARED);
        await writeAgentProtocol({ workspacePath: W, fs, enabled: true, tools, tracking: 'tynn' });
        expect(store.get(SHARED)).not.toBe(before);
        expect(store.get(SHARED)).toMatch(MODEL[1]![1]);
        let writes = 0;
        const counted: SyncFs = { ...fs, write: async (p, t) => { writes++; await fs.write(p, t); } };
        await writeAgentProtocol({ workspacePath: W, fs: counted, enabled: true, tools, tracking: 'tynn' });
        expect(writes).toBe(0);
    });

    it('an untrusted workspace\'s agent gets the same words, from Genie\'s own copy', async () => {
        const home = await mkdtemp(join(tmpdir(), 'genie2-protocol-untrusted-'));
        try {
            const signedIn = await writeGenieInstructions(home, tools, 'tynn');
            for (const [what, pattern] of MODEL) expect(signedIn.promptText, what).toMatch(pattern);
            const out = await writeGenieInstructions(home, tools);
            expect(out.promptText).toMatch(FALLBACK);
            expect(out.codexPromptText).toMatch(FALLBACK);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });
});

describe('the workspace sync takes the sign-in from Genie\'s Tynn account', () => {
    const pty: PtyPort = {
        open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    const account = (signedIn: boolean): TynnSessionPort => ({ status: () => ({ signedIn }), request: async () => ({ ok: false, status: 404, json: async () => null }) });
    const opened: Array<{ services: ComposedServices; dirs: string[] }> = [];
    afterEach(async () => {
        for (const o of opened.splice(0)) {
            await o.services.shutdown();
            for (const d of o.dirs) await rm(d, { recursive: true, force: true });
        }
    });
    const syncWith = async (tynn: (() => TynnSessionPort | null) | undefined) => {
        const dir = await mkdtemp(join(tmpdir(), 'genie2-protocol-compose-'));
        const ws = await mkdtemp(join(tmpdir(), 'genie2-protocol-ws-'));
        const services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, ...(tynn ? { tynn } : {}) });
        opened.push({ services, dirs: [dir, ws] });
        await services.syncAgentDocs(ws);
        return readFile(join(ws, '.agents', '_genie', 'shared.md'), 'utf8');
    };

    it('signed in: the Tynn work model; signed out, or no account at all: the fallback', async () => {
        const signedIn = await syncWith(() => account(true));
        for (const [what, pattern] of MODEL) expect(signedIn, what).toMatch(pattern);
        expect(await syncWith(() => account(false))).toMatch(FALLBACK);
        expect(await syncWith(() => null)).toMatch(FALLBACK);
        expect(await syncWith(undefined)).toMatch(FALLBACK);
    });

    it('signing in or out of Tynn writes every workspace\'s protocol again (main), not only at start', async () => {
        const main = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
        const hook = main.match(/tynnAccount\?\.onChange\(\(\) => \{\r?\n\s*\/\/ THE WORK MODEL[\s\S]*?\r?\n {12}\}\);/)?.[0];
        expect(hook).toBeDefined();
        expect(hook).toContain('composed.syncAgentDocs(w.path)');
        expect(hook).not.toContain('status().signedIn) return');
    });
});
