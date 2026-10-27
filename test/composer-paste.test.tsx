import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { AgentId } from '../src/core/identity.js';
import type { LiveSession } from '../src/core/roster.js';
import type { Attachment, PromptBlock } from '../src/core/prompt-content.js';

/**
 * THE CHAT COMPOSER ON REACT-FANCY 5.39.0 (react-fancy#32, asked for by this composer).
 *
 * 1. Every `PromptInput` Genie renders has the quiet footer — the paperclip and the send arrow as icons, the shortcut
 *    in the send button's tooltip, NO inline kbd hint — and holds long pastes and pasted images as pills.
 * 2. The meter is the agent's REAL context: the provider's last usage report, used and window both. Never reported =
 *    no meter. It used to be `0 / 200.0k` for every agent, at any fill, because Genie passed a made-up window.
 * 3. A pasted image reaches the agent as ONE image content block beside the text — in Genie and in the doctor window,
 *    whose prompt carried text only and dropped every file.
 *
 * No DOM (house rule): the markup is react-fancy's own, rendered statically and read through its stable handles
 * (`data-react-fancy-prompt-input-*`, `data-react-fancy-composer-input`); the submit is the props `PromptInput`
 * received, captured and called exactly as its send button calls them.
 */
const seen = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@particle-academy/react-fancy', async (original) => {
    const real = await original<typeof import('@particle-academy/react-fancy')>();
    const PromptInput = (props: Record<string, unknown>) => { seen.push(props); return (real.PromptInput as unknown as { render: (p: unknown, ref: null) => unknown }).render(props, null); };
    return { ...real, PromptInput };
});
const { ChatFlyout } = await import('../src/renderer/components/ChatFlyout.js');
const { DoctorApp } = await import('../src/renderer/DoctorApp.js');
const { Shell } = await import('../src/renderer/Shell.js');
const { EMPTY_SNAPSHOT } = await import('../src/renderer/bridge.js');
const { promptContent } = await import('../src/core/prompt-content.js');
/*
 * The two modules this row adds are imported where they are used, not at the top: on origin/main they do not exist,
 * and a top-level import would fail the whole file at load — every test red for "module not found" instead of for
 * what it names. Loaded lazily, the composer, meter and source tests run on origin/main and fail on their assertions.
 */
const composer = () => import('../src/core/composer.js');
const doctorPromptModule = () => import('../src/main/doctor-prompt.js');

type ChatThread = import('../src/renderer/components/ChatFlyout.js').ChatThread;
type DoctorDetail = import('../src/renderer/DoctorApp.js').DoctorDetail;

const count = (html: string, needle: string): number => html.split(needle).length - 1;
const lastProps = (): Record<string, unknown> => seen.at(-1)!;

const THREAD: ChatThread = { agentId: 'a_lark', name: 'lark', fidelity: 'declared', unread: null, messages: [] };
const session = (contextUsed: number | null, contextSize: number | null): LiveSession =>
    ({ running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed, contextSize, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null }) as LiveSession;

const row: AgentRow = {
    id: 'a_lark', name: 'lark', provider: 'claude', workspaceId: 'ws_example', fidelity: 'declared', state: 'working', duration: '3m',
    ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null,
    contextUsed: null, contextSize: null,
} as AgentRow;

const renderShell = (chatSession: LiveSession | null) => {
    seen.length = 0;
    const html = renderToStaticMarkup(
        <Shell
            route="genie://dashboard?chat=a_lark"
            snapshot={{ ...EMPTY_SNAPSHOT, agents: [row], workspaces: [{ id: 'ws_example', path: '/srv/example.test', agentsKnown: true }] }}
            servable={['dashboard', 'deck', 'agent', 'workspace']}
            agentDetail={null}
            agentResolved={false}
            selectedRowId={null}
            chatThread={THREAD}
            chatSession={chatSession}
            pinned={null}
            onNavigate={() => {}}
            onOpenAgent={() => {}}
            onAddAgent={() => {}}
            onAddWorkspace={() => {}}
            onOpenPalette={() => {}}
            onSelectRow={() => {}}
            onSend={() => {}}
            onCloseChat={() => {}}
            answeringApproval={null}
            onAnswerApproval={() => {}}
            onAnswerDeckItem={() => {}}
        />,
    );
    return { html, props: lastProps() };
};

const doctorDetail = (s: LiveSession | null): DoctorDetail => ({
    agent: { id: 'agent_osa', name: 'genie', provider: 'claude', fidelity: 'declared', cwd: '/srv/example.test/osa' },
    session: s,
    rows: [],
    turns: 0,
    cost: null,
});
const renderDoctor = (s: LiveSession | null, onSend: (text: string, files?: readonly Attachment[]) => void = () => {}) => {
    seen.length = 0;
    const html = renderToStaticMarkup(<DoctorApp facts={null} connect={null} detail={doctorDetail(s)} onSend={onSend} onStart={() => {}} onAnswerApproval={() => {}} />);
    return { html, props: lastProps() };
};

const renderFlyout = (onSend: (text: string, files?: readonly Attachment[]) => void = () => {}) => {
    seen.length = 0;
    const html = renderToStaticMarkup(<ChatFlyout thread={THREAD} onSend={onSend} onClose={() => {}} />);
    return { html, props: lastProps() };
};

/** The footer every composer must have, read through react-fancy's handles — counted, so a second composer or a lost one is named. */
function expectQuietFooter(html: string): void {
    expect(count(html, 'data-react-fancy-composer-input=""')).toBe(1);
    expect(count(html, 'data-react-fancy-prompt-input-attach=""')).toBe(1);
    expect(count(html, 'aria-label="Attach files"')).toBe(1);
    expect(count(html, 'data-react-fancy-prompt-input-send=""')).toBe(1);
    expect(count(html, 'aria-label="Send"')).toBe(1);
    // The shortcut lives in the send button's tooltip now: no inline `Ctrl + Enter to send`.
    expect(count(html, 'data-react-fancy-prompt-input-hint')).toBe(0);
    expect(count(html, 'to send</span>')).toBe(0);
}

describe('every composer has the quiet footer and holds pastes as pills', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : []; });
    const tags = files(join(import.meta.dirname, '../src/renderer')).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/<PromptInput\b[\s\S]*?\/>/g)].map((m) => ({ f, tag: m[0] })));

    it('each PromptInput in src/renderer passes the same options (positive control: ChatFlyout’s is found)', () => {
        expect(tags.filter((t) => t.f.endsWith('ChatFlyout.tsx'))).toHaveLength(1);
        const wanted = ['attachButton="icon"', 'sendButton="icon"', 'pasteThreshold={PASTE_PILL_CHARS}', 'pasteImages', 'previewChars={30}', "meter: 'near-limit'"];
        expect(tags.flatMap((t) => wanted.filter((w) => !t.tag.includes(w)).map((w) => `${t.f}: ${w}`))).toEqual([]);
        expect(tags.filter((t) => /\bshowHint\b/.test(t.tag))).toHaveLength(0);
    });

    it('the chat flyout, the Shell’s chat and the doctor window each render it — icon attach, icon send, no kbd hint', () => {
        expectQuietFooter(renderFlyout().html);
        expectQuietFooter(renderShell(session(10_000, 1_000_000)).html);
        expectQuietFooter(renderDoctor(session(10_000, 1_000_000)).html);
    });

    /*
     * THE SMOKE FINDS THE COMPOSER BY GENIE'S OWN HANDLE (PR #313, CI run 38801183441). With `pasteThreshold` /
     * `pasteImages`, 5.39.0's `PromptInput` renders its inline editor — a `contenteditable` `role="textbox"` — and no
     * `<textarea>` at all, so `scripts/smoke-cdp.mjs` waiting for `textarea` timed out on a composer that was there.
     * The smoke now waits for an editable input inside `[data-chat-composer]`: one handle, on the composer only, never
     * on the "no agent to message" notice that stands in its place.
     */
    it('Genie’s [data-chat-composer] wraps exactly one editable input, and there is no textarea (counted)', () => {
        const { html } = renderFlyout();
        expect(count(html, 'data-chat-composer=""')).toBe(1);
        // React's static markup keeps the prop's casing (`contentEditable`); the live DOM's attribute names are
        // case-insensitive, which is why the smoke's `[contenteditable="true"]` matches the same element.
        const inside = html.slice(html.indexOf('data-chat-composer=""'));
        expect(count(inside, 'contentEditable="true"')).toBe(1);
        expect(count(inside, 'role="textbox"')).toBe(1);
        expect(count(html, '<textarea')).toBe(0);
    });

    it('CONTROL: a blocked flyout has no composer, so the handle is absent with it', () => {
        seen.length = 0;
        const html = renderToStaticMarkup(<ChatFlyout thread={THREAD} scope={{ kind: 'blocked', reason: 'No agent here to message.' }} onSend={() => {}} onClose={() => {}} />);
        expect(count(html, 'data-chat-blocked=""')).toBe(1);
        expect(count(html, 'data-chat-composer=""')).toBe(0);
        expect(count(html, 'contentEditable="true"')).toBe(0);
    });

    it('the props are the ones the API names', () => {
        const { props } = renderFlyout();
        expect(props).toMatchObject({ attachButton: 'icon', sendButton: 'icon', pasteThreshold: 200, pasteImages: true, previewChars: 30 });
        expect(props.showHint).toBeUndefined();
    });
});

describe('the meter is the agent’s REAL context, or no meter', () => {
    it('composerMeter: both figures reported → them; anything unknown → null (counted over every unknown shape)', async () => {
        const { composerMeter } = await composer();
        expect(composerMeter(session(950_000, 1_000_000))).toEqual({ used: 950_000, size: 1_000_000 });
        // A report over its own window is the provider's figure, passed through (the owner's ledger: 1858.9k / 1000k).
        expect(composerMeter(session(1_858_900, 1_000_000))).toEqual({ used: 1_858_900, size: 1_000_000 });
        const unknown = [null, undefined, session(null, 1_000_000), session(950_000, null), session(null, null), session(5, 0), session(-1, 10)];
        expect(unknown.filter((s) => composerMeter(s) !== null)).toEqual([]);
    });

    it('the Shell’s chat: the meter draws the subject’s used / window, in the warning colour past 90%', () => {
        const { html, props } = renderShell(session(950_000, 1_000_000));
        expect(props).toMatchObject({ usedTokens: 950_000, budgetTokens: 1_000_000, meter: 'near-limit' });
        expect(count(html, 'data-react-fancy-prompt-input-meter=""')).toBe(1);
        expect(html).toMatch(/data-react-fancy-prompt-input-meter="" data-level="warn"/);
        expect(html).toContain('950.0k / 1000.0k');
    });

    it('CONTROL: a window never reported → no meter at all, and no made-up window behind it', () => {
        for (const s of [session(950_000, null), session(null, null), null]) {
            const { html, props } = renderShell(s);
            expect(count(html, 'data-react-fancy-prompt-input-meter')).toBe(0);
            expect(props.meter).toBe('hidden');
            expect(props.usedTokens).toBeUndefined();
            expect(props.budgetTokens).not.toBe(200_000);
        }
    });

    it('the doctor window: genie’s own used / window, and no meter when it has not reported', () => {
        const reported = renderDoctor(session(800_000, 1_000_000));
        expect(reported.props).toMatchObject({ usedTokens: 800_000, budgetTokens: 1_000_000, meter: 'near-limit' });
        expect(reported.html).toMatch(/data-react-fancy-prompt-input-meter="" data-level="muted"/);
        const unreported = renderDoctor(session(null, null));
        expect(count(unreported.html, 'data-react-fancy-prompt-input-meter')).toBe(0);
        expect(unreported.props.budgetTokens).not.toBe(200_000);
    });

    it('below 75% the near-limit meter stays out of the way (positive control for the count above: same props, hidden by level)', () => {
        const { html, props } = renderShell(session(100_000, 1_000_000));
        expect(props).toMatchObject({ usedTokens: 100_000, budgetTokens: 1_000_000, meter: 'near-limit' });
        expect(count(html, 'data-react-fancy-prompt-input-meter')).toBe(0);
    });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const pasted = (n: number) => ({ id: `image-${n}`, name: 'image.png', bytes: PNG.byteLength, file: new File([PNG], 'image.png', { type: 'image/png' }), type: 'image/png' });
const picked = (name: string, body: string) => {
    const bytes = new TextEncoder().encode(body);
    return { id: `file-${name}`, name, bytes: bytes.byteLength, file: new File([bytes], name, { type: 'text/plain' }), type: 'text/plain' };
};
const ACCEPTS = { image: true, textResource: true };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const blocks = (text: string, files: readonly Attachment[]): PromptBlock[] => {
    const built = promptContent(text, files, ACCEPTS, b64);
    if (!built.ok) throw new Error(built.reason);
    return typeof built.content === 'string' ? [{ type: 'text', text: built.content }] : built.content;
};

/** Submit through the props PromptInput received — what its send button does — and wait for the flyout's onSend. */
async function submit(text: string, attachments: unknown[]): Promise<{ text: string; files: readonly Attachment[] }> {
    const sent: Array<{ text: string; files: readonly Attachment[] }> = [];
    const { props } = renderFlyout((t, f) => { sent.push({ text: t, files: f ?? [] }); });
    expect(props.pasteImages).toBe(true);
    (props.onSubmit as (t: string, a: unknown[]) => void)(text, attachments);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    return sent[0]!;
}

describe('a pasted image reaches the agent as an image block, beside the text', () => {
    it('one pasted image → ONE image block and the text, its marker kept and the file named after it', async () => {
        const text = 'the login fails here [Pasted image 1] after the redirect';
        const sent = await submit(text, [pasted(1)]);
        expect(sent.text).toBe(text);
        expect(sent.files.map((f) => f.name)).toEqual(['Pasted image 1.png']);
        const out = blocks(sent.text, sent.files);
        expect(out.filter((b) => b.type === 'image')).toHaveLength(1);
        expect(out.filter((b) => b.type === 'text')).toEqual([{ type: 'text', text }]);
        expect(out.find((b) => b.type === 'image')).toMatchObject({ mimeType: 'image/png', data: b64(PNG) });
    });

    it('a paste-only message is sent: the marker is the text, the image its block', async () => {
        const sent = await submit('[Pasted image 2]', [pasted(2)]);
        const out = blocks(sent.text, sent.files);
        expect(out.map((b) => b.type)).toEqual(['text', 'image']);
    });

    it('a picked file keeps its own name; only the pasted image is renamed (counted)', async () => {
        const sent = await submit('compare notes.txt with [Pasted image 1]', [picked('notes.txt', 'release notes'), pasted(1)]);
        expect(sent.files.map((f) => f.name)).toEqual(['notes.txt', 'Pasted image 1.png']);
        const out = blocks(sent.text, sent.files);
        expect(out.filter((b) => b.type === 'image')).toHaveLength(1);
        expect(out.filter((b) => b.type === 'resource')).toHaveLength(1);
    });

    it('CONTROL: a text-only message → zero image blocks, zero files', async () => {
        const sent = await submit('just words for lark', []);
        expect(sent.files).toHaveLength(0);
        expect(blocks(sent.text, sent.files).filter((b) => b.type === 'image')).toHaveLength(0);
    });

    it('namePastedImages renames nothing without a marker, and nothing that is not an image (counted)', async () => {
        const { namePastedImages } = await composer();
        const files = [picked('a.txt', 'a'), picked('b.txt', 'b')];
        expect(namePastedImages('no marker here', files).map((f) => f.name)).toEqual(['a.txt', 'b.txt']);
        expect(namePastedImages('typed [Pasted image 1] by hand', files).map((f) => f.name)).toEqual(['a.txt', 'b.txt']);
        expect(namePastedImages('[Pasted image 1] [Pasted image 2]', [pasted(1)]).map((f) => f.name)).toEqual(['image.png']);
    });
});

describe('the doctor window sends its files too', () => {
    const host = () => {
        const calls: Array<{ text: string; names: string[] }> = [];
        return { calls, promptWith: (_id: AgentId, text: string, attachments: readonly Attachment[]) => { calls.push({ text, names: attachments.map((a) => a.name) }); return { ok: true as const }; } };
    };
    const id = 'agent_osa' as AgentId;
    const file = { name: 'Pasted image 1.png', type: 'image/png', bytes: PNG };

    it('a pasted image goes to the session with the text — one call, one file', async () => {
        const { doctorPrompt } = await doctorPromptModule();
        const h = host();
        expect(doctorPrompt(h, id, 'see [Pasted image 1]', [file])).toBe(true);
        expect(h.calls).toEqual([{ text: 'see [Pasted image 1]', names: ['Pasted image 1.png'] }]);
    });

    it('CONTROL: text alone still sends, with no files; nothing at all and malformed files send nothing (counted)', async () => {
        const { doctorPrompt } = await doctorPromptModule();
        const h = host();
        expect(doctorPrompt(h, id, 'hello genie', undefined)).toBe(true);
        expect(h.calls).toEqual([{ text: 'hello genie', names: [] }]);
        const refused = [doctorPrompt(h, id, '   ', []), doctorPrompt(h, id, 42, []), doctorPrompt(h, id, 'x', [{ name: '', type: '', bytes: PNG }])];
        expect(refused.filter((r) => r !== false)).toEqual([]);
        expect(h.calls).toHaveLength(1);
    });

    it('DoctorApp hands the composer’s files to onSend', async () => {
        const sent: Array<readonly Attachment[] | undefined> = [];
        const { props } = renderDoctor(session(null, null), (_t, f) => { sent.push(f); });
        (props.onSubmit as (t: string, a: unknown[]) => void)('[Pasted image 1]', [pasted(1)]);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]!.map((f) => f.name)).toEqual(['Pasted image 1.png']);
    });

    it('the doctor preload and IPC carry the files (source: one handler, through doctorPrompt)', () => {
        const preload = readFileSync(join(import.meta.dirname, '../src/main/doctor-preload.ts'), 'utf8');
        expect(preload.match(/ipcRenderer\.invoke\('doctor:prompt', text, files \?\? \[\]\)/g) ?? []).toHaveLength(1);
        const main = readFileSync(join(import.meta.dirname, '../src/main/doctor.ts'), 'utf8');
        expect(main.match(/ipcMain\.handle\('doctor:prompt'/g) ?? []).toHaveLength(1);
        expect(main.match(/doctorPrompt\(host, record\.id, text, files\)/g) ?? []).toHaveLength(1);
    });
});

describe('no made-up context window anywhere in src/', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) ? [p] : []; });
    const MADE_UP = /\b200_?000\b/g;

    it('the pattern finds both spellings (positive control on the gauge)', () => {
        expect('contextTokens={200_000} budget 200000 2000000 1200000'.match(MADE_UP)).toHaveLength(2);
    });

    it('no file in src/ contains 200_000 or 200000', () => {
        const hits = files(join(import.meta.dirname, '../src')).flatMap((f) => (readFileSync(f, 'utf8').match(MADE_UP) ?? []).map((m) => `${f}: ${m}`));
        expect(hits).toEqual([]);
    });
});
