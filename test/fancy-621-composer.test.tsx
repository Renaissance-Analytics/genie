import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/*
 * REACT-FANCY 6.21.0 IN THE COMPOSER AND THE THREAD (Tynn #637, #641, #642; the coordinator, 2026-11-12).
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

    it('react-fancy is 6.21.0', () => {
        expect(JSON.parse(readFileSync('package.json', 'utf8')).dependencies['@particle-academy/react-fancy']).toBe('6.21.0');
    });
});

describe('#641: the send-key hint is PromptInput’s own, inside the composer', () => {
    it('the hint is drawn in the action row, and Genie’s line under the composer is gone', async () => {
        const { ChatFlyout } = await import('../src/renderer/components/ChatFlyout.js');
        seen.prompt.length = 0;
        const html = renderToStaticMarkup(<ChatFlyout thread={{ agentId: 'a1', name: 'atlas', fidelity: 'declared', unread: null, messages: [], context: null }} onSend={() => {}} onClose={() => {}} />);
        const props = seen.prompt.at(-1)!;
        expect(props['showHint']).not.toBe(false);
        expect(props['submitKey']).toBe('enter');
        expect(html.split('data-react-fancy-prompt-input-hint').length - 1).toBe(1);
        expect(html).not.toContain('data-composer-keys');
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

    it('the chat flyout and the agent view both draw sent attachments with it, fed by the host’s read', () => {
        expect(src('src/renderer/components/ChatFlyout.tsx')).toContain('<SentAttachments');
        expect(src('src/renderer/components/StreamRow.tsx')).toContain('<SentAttachments');
        expect(src('src/renderer/App.tsx')).toMatch(/agents\.attachment\(/);
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
