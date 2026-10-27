import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Attachment } from '../src/core/prompt-content.js';

/**
 * THE CHAT'S COMPOSERS START FROM THE KEPT DRAFT (genie#1261, the persistence half). Each chat's `PromptInput` mounts with
 * its own `defaultDraft`, reports every change for its own chat, keeps attachments through Genie's store, and a send
 * clears that chat only — and a restored draft never takes the caret (genie#1235).
 *
 * No DOM (docs/decisions.md D3): the props Genie hands react-fancy are captured and called; the markup is asserted
 * through Genie's own handles.
 */
const seen = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@particle-academy/react-fancy', async (original) => {
    const real = await original<typeof import('@particle-academy/react-fancy')>();
    const PromptInput = (props: Record<string, unknown>) => { seen.push(props); return (real.PromptInput as unknown as { render: (p: unknown, ref: null) => unknown }).render(props, null); };
    return { ...real, PromptInput };
});
const { ChatFlyout } = await import('../src/renderer/components/ChatFlyout.js');
type ChatThread = import('../src/renderer/components/ChatFlyout.js').ChatThread;
const keeperModule = () => import('../src/core/chat-draft-keeper.js');

const thread = (agentId: string, name: string): ChatThread => ({ agentId, name, fidelity: 'declared', unread: null, messages: [] });
const A = thread('a_lark', 'lark');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const REF = '00000000-0000-4000-8000-000000000001';
const LARK = { v: 1 as const, text: 'half-typed to lark', pills: [], attachments: [{ id: 'f1', name: 'shot.png', type: 'image/png', bytes: 4, ref: REF }] };

async function keeper(stored: Record<string, unknown>) {
    const { ChatDraftKeeper } = await keeperModule();
    const calls: Array<[string, ...unknown[]]> = [];
    const files = new Map<string, Uint8Array>([[REF, PNG]]);
    const k = new ChatDraftKeeper({
        load: async () => stored,
        save: async (agentId: string, d: unknown) => { calls.push(['save', agentId, d]); },
        putFile: async () => REF,
        readFile: async (ref: string) => files.get(ref) ?? null,
        release: async (refs: readonly string[]) => { calls.push(['release', [...refs]]); },
    }, { setTimer: () => 0, clearTimer: () => {} });
    await k.load();
    return { k, calls };
}

describe('restore', () => {
    it('the chat’s composer mounts with ITS kept draft as defaultDraft, and the store’s hooks', async () => {
        const { k } = await keeper({ a_lark: LARK, a_wren: { v: 1, text: 'to wren', pills: [], attachments: [] } });
        seen.length = 0;
        renderToStaticMarkup(<ChatFlyout thread={A} drafts={k} onSend={() => {}} onClose={() => {}} />);
        expect(seen).toHaveLength(1);
        expect(seen[0]!.defaultDraft).toEqual(LARK);
        expect(typeof seen[0]!.onDraftChange).toBe('function');
        expect(typeof seen[0]!.persistAttachment).toBe('function');
        expect(typeof seen[0]!.restoreAttachment).toBe('function');
    });

    it('while the drafts are still loading, no composer is mounted (it would start empty and never take the draft)', () => {
        seen.length = 0;
        const html = renderToStaticMarkup(<ChatFlyout thread={A} drafts="loading" onSend={() => {}} onClose={() => {}} />);
        expect(seen).toHaveLength(0);
        expect(html).not.toContain('data-chat-draft=');
    });

    it('CONTROL: no drafts store (the doctor window, a remote host): the composer mounts as before, with no draft props', () => {
        seen.length = 0;
        renderToStaticMarkup(<ChatFlyout thread={A} onSend={() => {}} onClose={() => {}} />);
        expect(seen).toHaveLength(1);
        expect('defaultDraft' in seen[0]!).toBe(false);
        expect('onDraftChange' in seen[0]!).toBe(false);
    });

    it('a change in the composer is kept under THAT chat', async () => {
        const { k } = await keeper({});
        seen.length = 0;
        renderToStaticMarkup(<ChatFlyout thread={A} drafts={k} onSend={() => {}} onClose={() => {}} />);
        (seen[0]!.onDraftChange as (d: unknown) => void)({ v: 1, text: 'new words', pills: [], attachments: [] });
        expect(k.initial('a_lark')).toEqual({ v: 1, text: 'new words', pills: [], attachments: [] });
        expect(k.initial('a_wren')).toBeUndefined();
    });
});

describe('a send clears that chat only, and its files', () => {
    it('a restored attachment (a ref, no File) is sent with its bytes from Genie’s store; then the sent files are released', async () => {
        const { k, calls } = await keeper({ a_lark: LARK });
        seen.length = 0;
        const sent: Array<[string, readonly Attachment[] | undefined, string | undefined]> = [];
        renderToStaticMarkup(<ChatFlyout thread={A} drafts={k} onSend={(text: string, files?: readonly Attachment[], agentId?: string) => { sent.push([text, files, agentId]); }} onClose={() => {}} />);
        (seen[0]!.onSubmit as (text: string, picked: unknown[]) => void)('half-typed to lark', [{ id: 'f1', name: 'shot.png', bytes: 4, type: 'image/png', ref: REF }]);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]![0]).toBe('half-typed to lark');
        expect(sent[0]![2]).toBe('a_lark');
        expect(sent[0]![1]![0]!.bytes).toEqual(PNG);
        await vi.waitFor(() => expect(calls).toContainEqual(['release', [REF]]));
        // The composer empties after a send (react-fancy) and that clears lark's entry, at once.
        (seen[0]!.onDraftChange as (d: unknown) => void)({ v: 1, text: '', pills: [], attachments: [] });
        expect(calls).toContainEqual(['save', 'a_lark', null]);
        expect(calls.filter((c) => c[0] === 'save' && c[1] !== 'a_lark')).toEqual([]);
    });
});

describe('a restored draft never takes the caret (genie#1235)', () => {
    const strip = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    it('restore is react-fancy’s uncontrolled defaultDraft — read at mount, which never moves focus (5.65.0 contract) — never setDraft, a ref, autoFocus or a focus call', async () => {
        const { k } = await keeper({ a_lark: LARK });
        seen.length = 0;
        renderToStaticMarkup(<ChatFlyout thread={A} drafts={k} onSend={() => {}} onClose={() => {}} />);
        const props = seen[0]!;
        expect(props.defaultDraft).toEqual(LARK);
        for (const p of ['autoFocus', 'draft', 'value', 'ref']) expect(p in props, p).toBe(false);
        const flyout = strip('../src/renderer/components/ChatFlyout.tsx');
        expect(flyout).not.toMatch(/\.focus\(|setDraft\(|autoFocus|focus:\s*true/);
        expect(strip('../src/core/chat-draft-keeper.ts')).not.toMatch(/\.focus\(|setDraft\(|focus:\s*true/);
    });

    it('the react-fancy Genie runs is one whose restore promises not to focus: 5.65.0 or later, defaultDraft and the focus option in its types', () => {
        const pkg = JSON.parse(readFileSync(new URL('../node_modules/@particle-academy/react-fancy/package.json', import.meta.url), 'utf8')) as { version: string };
        const [major, minor] = pkg.version.split('.').map(Number) as [number, number];
        expect(major > 5 || (major === 5 && minor >= 65), pkg.version).toBe(true);
        const ours = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
        expect(ours.dependencies['@particle-academy/react-fancy']).toBe('5.65.0');
    });
});

describe('wiring', () => {
    const strip = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    it('main keeps the drafts: opens the store after the registry has loaded, prunes deleted agents on every change, answers the window', () => {
        const main = strip('../src/main/main.ts');
        expect(main).toMatch(/ChatDraftStore\.open\(genieHome\(\)\)/);
        expect(main.indexOf('ChatDraftStore.open(')).toBeGreaterThan(main.indexOf('await registry.load('));
        expect(main).toMatch(/registry\.subscribe\(\(\) => \{ void drafts\.prune\(/);
        for (const ch of ['load', 'save', 'put-file', 'read-file', 'release']) expect(main).toContain(`'genie:chat-drafts-${ch}'`);
    });

    it('the preload hands the window the five calls; a remote host’s bridge has none (its agents are not this machine’s)', () => {
        const preload = strip('../src/main/preload.ts');
        for (const ch of ['load', 'save', 'put-file', 'read-file', 'release']) expect(preload).toContain(`'genie:chat-drafts-${ch}'`);
        expect(strip('../src/renderer/remote-bridge.ts')).not.toMatch(/chatDrafts/);
    });

    it('the app loads them once per bridge, flushes on unload (a reload), and the shell hands them to the chat', () => {
        const app = strip('../src/renderer/App.tsx');
        expect(app).toMatch(/new ChatDraftKeeper\(/);
        expect(app).toMatch(/addEventListener\('pagehide'/);
        expect(strip('../src/renderer/Shell.tsx')).toMatch(/drafts=\{chatDrafts\}/);
    });
});
