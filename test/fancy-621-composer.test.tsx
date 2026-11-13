import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/*
 * REACT-FANCY 6.24.0 IN THE COMPOSER AND THE THREAD (Tynn #664, re-applying PR #1882's 6.21 adoption: #637, #641, #642).
 * 6.24.0 also carries the kit's TabsList and Autocomplete loop fixes (Tynn issue #712, React #185 in the #662 soak).
 *  - #637: PromptInput takes the person's send key itself (`submitKey`, any recorded combination), so Genie's boundary that
 *    pressed Send for it goes, and with it the extra Ctrl/Cmd+Enter send the component kept. Settings records keys with the
 *    kit's HotkeyCapture; what is stored does not change (an accelerator, as before).
 *  - #641: the send-key hint is PromptInput's own, in the action row left of Send (the owner: "this line should be in the
 *    box, not under it"); Genie's line under the composer goes.
 *  - #642: a sent message's image is the kit's ImagePill, its thumbnail read from the host on first hover (#1879's read).
 */
const seen: { prompt: Array<Record<string, unknown>>; pill: Array<Record<string, unknown>> } = { prompt: [], pill: [] };
vi.mock('@particle-academy/react-fancy', async (original) => {
    const real = await original<Record<string, unknown>>();
    const PromptInput = (props: Record<string, unknown>) => { seen.prompt.push(props); return (real.PromptInput as unknown as { render: (p: unknown, ref: null) => unknown }).render(props, null); };
    const ImagePill = (props: Record<string, unknown>) => { seen.pill.push(props); return (real.ImagePill as unknown as { render: (p: unknown, ref: null) => unknown }).render(props, null); };
    return { ...real, PromptInput, ImagePill };
});

const load = async (path: string): Promise<Record<string, unknown>> => (await import(/* @vite-ignore */ path).catch(() => ({}))) as Record<string, unknown>;
const strings = await load('../src/renderer/hotkey-strings.js');
const pillsCore = await load('../src/core/sent-attachments.js');
const sentModule = await load('../src/renderer/components/SentAttachments.js');
const fn = <T,>(mod: Record<string, unknown>, name: string): T => { expect(mod[name], name).toBeDefined(); return mod[name] as T; };
const src = (path: string) => readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('#637: the send key as the kit records it, stored as Genie always stored it', () => {
    const toHotkey = () => fn<(accelerator: string, platform: string) => string>(strings, 'toHotkey');
    const fromHotkey = () => fn<(hotkey: string, platform: string) => string | null>(strings, 'fromHotkey');

    it('an accelerator becomes the kit’s string (Ctrl or ⌘ for CommandOrControl, by platform)', () => {
        expect(toHotkey()('Enter', 'win32')).toBe('enter');
        expect(toHotkey()('CommandOrControl+Enter', 'win32')).toBe('ctrl+enter');
        expect(toHotkey()('CommandOrControl+Enter', 'darwin')).toBe('meta+enter');
        expect(toHotkey()('Shift+CommandOrControl+P', 'linux')).toBe('ctrl+shift+p');
        expect(toHotkey()('Alt+S', 'win32')).toBe('alt+s');
        expect(toHotkey()('F5', 'win32')).toBe('f5');
        expect(toHotkey()('', 'win32')).toBe('');
    });

    it('a recorded combination is stored as the accelerator Genie stored before (CONTROL: the same values round-trip)', () => {
        expect(fromHotkey()('ctrl+enter', 'win32')).toBe('CommandOrControl+Enter');
        expect(fromHotkey()('meta+enter', 'darwin')).toBe('CommandOrControl+Enter');
        expect(fromHotkey()('ctrl+shift+p', 'linux')).toBe('CommandOrControl+Shift+P');
        expect(fromHotkey()('alt+s', 'win32')).toBe('Alt+S');
        expect(fromHotkey()('f6', 'win32')).toBe('F6');
        expect(fromHotkey()('enter', 'win32')).toBe('Enter');
        expect(fromHotkey()('shift+arrowup', 'win32')).toBe('Shift+ArrowUp');
        expect(fromHotkey()('', 'win32')).toBeNull();
        for (const stored of ['Enter', 'CommandOrControl+Enter', 'Alt+S', 'F5', 'CommandOrControl+Shift+P']) expect(fromHotkey()(toHotkey()(stored, 'win32'), 'win32'), stored).toBe(stored);
    });

    it('the chat composer is handed the person’s key, and Genie no longer presses Send for it', () => {
        const flyout = src('src/renderer/components/ChatFlyout.tsx');
        expect(flyout).toMatch(/submitKey=\{toHotkey\(sendKey, keysPlatform\)\}/);
        expect(flyout).not.toContain('SendKeyBoundary');
        expect(src('test/send-key-697.test.tsx')).not.toContain('SendKeyBoundary');
    });

    it('Settings records with the kit’s HotkeyCapture, and Genie’s own capture is gone', () => {
        const capture = src('src/renderer/components/HotkeyCapture.tsx');
        expect(capture).toMatch(/import \{[^}]*HotkeyCapture as FancyHotkeyCapture[^}]*\} from '@particle-academy\/react-fancy'/);
        expect(capture).not.toContain('onKeyDown');
        expect(src('src/renderer/App.tsx')).toContain('[data-react-fancy-hotkey-capture][data-state="capturing"]');
    });

    it('react-fancy is 6.24.0, in package.json and the lockfile', () => {
        expect(JSON.parse(readFileSync('package.json', 'utf8')).dependencies['@particle-academy/react-fancy']).toBe('6.24.0');
        const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
        expect(lock.packages['']!.dependencies!['@particle-academy/react-fancy']).toBe('6.24.0');
        expect(lock.packages['node_modules/@particle-academy/react-fancy']!.version).toBe('6.24.0');
    });
});

// The coordinator, 2026-11-12: the owner asked for THAT line ("Enter to send · Shift+Enter for a new line") to move into the
// box — both halves. Genie's full line goes in PromptInput's `beforeSend` slot (left of Send, truncating before it), and the
// kit's own hint, which names only the send key, is off so nothing is said twice.
describe('#641: Genie’s whole line, inside the composer, left of Send', () => {
    const render = async () => {
        const { ChatFlyout } = await import('../src/renderer/components/ChatFlyout.js');
        seen.prompt.length = 0;
        const html = renderToStaticMarkup(<ChatFlyout thread={{ agentId: 'a1', name: 'atlas', fidelity: 'declared', unread: null, messages: [], context: null }} onSend={() => {}} onClose={() => {}} />);
        return { html, props: seen.prompt.at(-1)! };
    };
    const slot = (html: string) => html.match(/data-react-fancy-prompt-input-before-send[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';

    it('both keys, in the slot left of Send; the kit’s own hint is off; nothing under the box', async () => {
        const { html, props } = await render();
        expect(props['showHint']).toBe(false);
        expect(props['submitKey']).toBe('enter');
        expect(slot(html)).toContain('Enter to send · Shift+Enter for a new line');
        expect(html).not.toContain('data-react-fancy-prompt-input-hint');
        // The line is in the composer's action row: before the send button, inside the composer.
        expect(html.indexOf('data-react-fancy-prompt-input-before-send')).toBeLessThan(html.indexOf('data-react-fancy-prompt-input-send'));
        expect(html.split('data-composer-keys').length - 1).toBe(1);
    });

    it('follows a changed send key', async () => {
        const store = await import('../src/renderer/send-key-store.js');
        store.setSendKey('CommandOrControl+Enter');
        try {
            const { html, props } = await render();
            expect(props['submitKey']).toBe('ctrl+enter');
            expect(slot(html)).toContain('Ctrl+Enter to send · Enter for a new line');
        } finally { store.setSendKey('Enter'); }
    });

    // The send button's tooltip and name are the kit's, and since the composer is handed the person's key they name THAT
    // key, never the kit's built-in Ctrl/Cmd+Enter (Tynn #637).
    const sendButton = (html: string) => html.match(/<button[^>]*data-react-fancy-prompt-input-send[^>]*>/)?.[0] ?? '';
    it('the send button names the person’s key: Enter by default', async () => {
        const { html } = await render();
        expect(sendButton(html)).toContain('aria-keyshortcuts="Enter"');
        expect(sendButton(html)).toContain('aria-label="Send (Enter)"');
    });

    it('the send button names a changed key (CONTROL: the default above says Enter)', async () => {
        const store = await import('../src/renderer/send-key-store.js');
        store.setSendKey('CommandOrControl+Enter');
        try {
            const { html } = await render();
            expect(sendButton(html)).toContain('aria-keyshortcuts="Control+Enter"');
            expect(sendButton(html)).not.toContain('aria-keyshortcuts="Enter"');
        } finally { store.setSendKey('Enter'); }
    });
});

describe('#642: a sent image is the kit’s ImagePill, read from the host on first hover', () => {
    type Ref = { id: string; name: string; mimeType: string; bytes: number };
    const refs: Ref[] = [{ id: 'a'.repeat(32), name: 'Pasted image 3.png', mimeType: 'image/png', bytes: 72 }, { id: 'b'.repeat(32), name: 'shot.png', mimeType: 'image/png', bytes: 9 }];

    it('each name meets its kept image, in order; a file with none kept stays a name', () => {
        const pair = fn<(names: readonly string[], refs: readonly Ref[] | undefined) => Array<{ name: string; ref: Ref | null }>>(pillsCore, 'attachmentPills');
        expect(pair(['Pasted image 3.png', 'notes.txt', 'shot.png'], refs)).toEqual([
            { name: 'Pasted image 3.png', ref: refs[0] }, { name: 'notes.txt', ref: null }, { name: 'shot.png', ref: refs[1] },
        ]);
        expect(pair(['a.png', 'a.png'], [{ ...refs[0]!, name: 'a.png' }, { ...refs[1]!, name: 'a.png' }]).map((p) => p.ref?.id)).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
        expect(pair(['notes.txt'], undefined)).toEqual([{ name: 'notes.txt', ref: null }]);
    });

    type Sent = (p: { id: string; names: readonly string[]; refs?: readonly Ref[] | undefined; load?: ((attachmentId: string) => Promise<{ ok: true; mimeType: string; data: string; bytes: number } | { ok: false; reason: string }>) | undefined }) => React.ReactElement;
    it('an image pill loads its thumbnail only when asked, as a data URL from the host’s read', async () => {
        const Sent = fn<Sent>(sentModule, 'SentAttachments');
        const load = vi.fn(async (id: string) => ({ ok: true as const, mimeType: 'image/png', data: `DATA-${id.slice(0, 2)}`, bytes: 4 }));
        seen.pill.length = 0;
        const html = renderToStaticMarkup(<Sent id="m1" names={['Pasted image 3.png', 'notes.txt']} refs={refs} load={load} />);
        expect(html).toContain('data-react-fancy-image-pill');
        expect(html).toContain('notes.txt');
        expect(load).not.toHaveBeenCalled();
        const pill = seen.pill.find((p) => p['label'] === 'Pasted image 3.png')!;
        await expect((pill['loadThumbnail'] as () => Promise<string>)()).resolves.toBe('data:image/png;base64,DATA-aa');
        expect(load).toHaveBeenCalledExactlyOnceWith('a'.repeat(32));
        expect(seen.pill.some((p) => p['label'] === 'notes.txt')).toBe(false);
    });

    it('an image the host no longer keeps shows the pill’s error state, with the host’s reason', async () => {
        const Sent = fn<Sent>(sentModule, 'SentAttachments');
        seen.pill.length = 0;
        renderToStaticMarkup(<Sent id="m1" names={['Pasted image 3.png']} refs={refs} load={async () => ({ ok: false, reason: 'this image is no longer kept' })} />);
        await expect((seen.pill.at(-1)!['loadThumbnail'] as () => Promise<string>)()).rejects.toThrow('this image is no longer kept');
    });

    it('CONTROL: with no way to read the host, an image is a plain pill and nothing is asked', () => {
        const Sent = fn<Sent>(sentModule, 'SentAttachments');
        seen.pill.length = 0;
        const html = renderToStaticMarkup(<Sent id="m1" names={['Pasted image 3.png']} refs={refs} />);
        expect(seen.pill).toHaveLength(0);
        expect(html).toContain('Pasted image 3.png');
    });

    it('the window reads the host for both the desktop and the phone', () => {
        // Desktop (Shell: the chat and the agent view) and the phone (MobileAgent: its chat and work panels).
        expect(src('src/renderer/App.tsx').match(/agents\.attachment\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });
});

/*
 * ONE SET OF ROWS FOR THE DESKTOP AND THE PHONE (Tynn #652, #664): the chat's rows are `ChatMessages`, shared by the
 * desktop chat and the phone's chat panel, so a sent image's pill lives there once and both draw it.
 */
describe('#642 on the shared chat rows: desktop chat and phone chat both show a sent image as the kit’s pill', () => {
    type Ref = { id: string; name: string; mimeType: string; bytes: number };
    const ref: Ref = { id: 'd'.repeat(32), name: 'shot.png', mimeType: 'image/png', bytes: 9 };
    const reply = (id: string) => ({ ok: true as const, mimeType: 'image/png', data: `DATA-${id.slice(0, 2)}`, bytes: 4 });
    const sent = { id: 'm1', from: 'you', who: 'you' as const, text: 'look', delivered: true, attachments: ['shot.png', 'notes.txt'], attachmentRefs: [ref] };
    const thread = { agentId: 'a1', name: 'atlas', fidelity: 'declared' as const, unread: null, messages: [sent], context: null };
    const noRefs = { files: false, agents: [], workspaces: [] };
    const pillFor = (label: string) => seen.pill.find((p) => p['label'] === label);

    it('ChatMessages: the image is a pill read from the host on first hover; the text file stays a name', async () => {
        const { ChatMessages } = await import('../src/renderer/components/ChatFlyout.js');
        const load = vi.fn(async (id: string) => reply(id));
        seen.pill.length = 0;
        const html = renderToStaticMarkup(<ChatMessages messages={[sent] as never} thread={thread as never} refs={noRefs} mailOnly={false} {...({ loadAttachment: load } as object)} />);
        expect(html).toContain('data-chat-attachments="m1"');
        expect(html).toContain('notes.txt');
        expect(pillFor('notes.txt')).toBeUndefined();
        expect(load).not.toHaveBeenCalled();
        await expect((pillFor('shot.png')!['loadThumbnail'] as () => Promise<string>)()).resolves.toBe('data:image/png;base64,DATA-dd');
        expect(load).toHaveBeenCalledExactlyOnceWith(ref.id);
    });

    it('CONTROL: ChatMessages with no way to read the host draws names only', async () => {
        const { ChatMessages } = await import('../src/renderer/components/ChatFlyout.js');
        seen.pill.length = 0;
        const html = renderToStaticMarkup(<ChatMessages messages={[sent] as never} thread={thread as never} refs={noRefs} mailOnly={false} />);
        expect(html).toContain('shot.png');
        expect(seen.pill).toHaveLength(0);
    });

    it('the desktop chat flyout hands its rows the host read, bound to the thread’s agent', async () => {
        const { ChatFlyout } = await import('../src/renderer/components/ChatFlyout.js');
        const load = vi.fn(async (_agentId: string, id: string) => reply(id));
        seen.pill.length = 0;
        renderToStaticMarkup(<ChatFlyout thread={thread as never} onSend={() => {}} onClose={() => {}} {...({ loadAttachment: load } as object)} />);
        expect(pillFor('shot.png')).toBeDefined();
        await (pillFor('shot.png')!['loadThumbnail'] as () => Promise<string>)();
        expect(load).toHaveBeenCalledExactlyOnceWith('a1', ref.id);
    });

    const T = 1_760_000_000_000;
    const detail = {
        agent: { id: 'agent_a', name: 'atlas', provider: 'claude', fidelity: 'declared', cwd: '/w/tynn' },
        session: { running: true, turnState: 'idle', pendingApproval: null, failure: null, plan: null, startedAt: null },
        rows: [{ id: 'e1', at: T, event: { kind: 'message', speaker: 'you', peerName: null, text: 'look', attachments: ['shot.png', 'notes.txt'], attachmentRefs: [ref] } }],
        comms: [], turns: 1, cost: null, refusal: null,
    };
    const phone = async (panel: 'chat' | 'work', load?: (id: string) => Promise<ReturnType<typeof reply>>) => {
        const { MobileAgent } = await import('../src/renderer/components/MobileShell.js');
        const noop = () => {};
        seen.pill.length = 0;
        return renderToStaticMarkup(<MobileAgent detail={detail as never} sending={false} onBack={noop} onSend={noop} onStart={noop} onResumeLimit={noop} needs={[]} answering={null} onAnswer={noop}
            agents={{ rows: [], onOpen: noop }} initialPanel={panel} {...(load ? ({ loadAttachment: load } as object) : {})} />);
    };

    it('the phone’s chat panel: the same pill, read from its host', async () => {
        const load = vi.fn(async (id: string) => reply(id));
        const html = await phone('chat', load);
        expect(html).toContain('data-react-fancy-image-pill');
        await (pillFor('shot.png')!['loadThumbnail'] as () => Promise<string>)();
        expect(load).toHaveBeenCalledExactlyOnceWith(ref.id);
    });

    it('the phone’s work panel: the message row carries the same pill', async () => {
        const load = vi.fn(async (id: string) => reply(id));
        await phone('work', load);
        expect(pillFor('shot.png')).toBeDefined();
        await (pillFor('shot.png')!['loadThumbnail'] as () => Promise<string>)();
        expect(load).toHaveBeenCalledExactlyOnceWith(ref.id);
    });

    it('CONTROL: a phone with no host read draws names, no pill', async () => {
        const html = await phone('chat');
        expect(html).toContain('shot.png');
        expect(seen.pill).toHaveLength(0);
    });

    it('the rows are drawn once, in ChatMessages: the flyout keeps no copy of its own', () => {
        const flyout = src('src/renderer/components/ChatFlyout.tsx');
        expect(flyout.match(/<SentAttachments/g)?.length ?? 0).toBe(1);
        expect(flyout.slice(flyout.indexOf('export function ChatMessages'))).toContain('<SentAttachments');
    });
});

describe('#642 in the agent view: a message row carries its attachments, paired with the images kept', () => {
    it('a sent message with an image and a text file', async () => {
        const { ledgerRow } = await import('../src/core/stream-view.js');
        const ref = { id: 'c'.repeat(32), name: 'shot.png', mimeType: 'image/png', bytes: 9 };
        const row = ledgerRow({ id: 'r1', at: 1, event: { kind: 'message', speaker: 'you', peerName: null, text: 'look', attachments: ['shot.png', 'notes.txt'], attachmentRefs: [ref] } } as never, { agentName: 'atlas' }) as unknown as { attachments?: unknown };
        expect(row.attachments).toEqual([{ name: 'shot.png', ref }, { name: 'notes.txt', ref: null }]);
    });

    it('CONTROL: a message with no files carries none', async () => {
        const { ledgerRow } = await import('../src/core/stream-view.js');
        const row = ledgerRow({ id: 'r1', at: 1, event: { kind: 'message', speaker: 'you', peerName: null, text: 'hi' } } as never, { agentName: 'atlas' }) as unknown as { attachments?: unknown };
        expect(row.attachments).toBeUndefined();
    });
});
