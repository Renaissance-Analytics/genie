import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MAX_OPEN_UPLOADS } from '../src/core/mobile-wire.js';
import { draftFileCount, fileLimitRefusal, incomingFileCount, MESSAGE_FILE_LIMIT } from '../src/core/composer.js';
import { composerFileGuard, type FileGuardEvent } from '../src/renderer/components/ComposerFileLimit.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * THE COMPOSER REFUSES THE FILE THAT WILL NOT GO, WHEN IT IS ADDED (the owner, 2026-11-16).
 *
 * A message carries at most MESSAGE_FILE_LIMIT files: the host's per-connection upload cap, because every file of a
 * message is staged before the message's one `prompt` call takes them (core/mobile-wire.ts MAX_OPEN_UPLOADS). The owner
 * pasted a fourth image, wrote a long message, and learned only at Send — "Not sent: Pasted image 13.png: only 3 uploads
 * at a time". The extra file is refused at the paste, the drop or the pick, with a transient toast (never a line that
 * moves the layout), and nothing of it enters the draft.
 *
 * No DOM (house rule): the rules are pure, and the guard's handlers are called with the event shape React hands them.
 */

const files = (...types: string[]) => types.map((type) => ({ type }));

function event(over: Partial<FileGuardEvent> = {}) {
    const e = { target: {}, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over };
    return e as FileGuardEvent & { preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn> };
}
const paste = (fileList: Array<{ type: string }>, text = '') => event({ clipboardData: { files: fileList, getData: (f: string) => (f === 'text/plain' ? text : '') } });

describe('how many files one message carries', () => {
    it('is the host’s upload cap: 3', () => {
        expect(MESSAGE_FILE_LIMIT).toBe(MAX_OPEN_UPLOADS);
        expect(MESSAGE_FILE_LIMIT).toBe(3);
    });

    it('a draft holds its picked files and its pasted images; a text pill is not a file', () => {
        expect(draftFileCount({ pills: [{ kind: 'image' }, { kind: 'text' }, { kind: 'image' }], attachments: [{}] })).toBe(3);
        expect(draftFileCount({ pills: [{ kind: 'text' }], attachments: [] })).toBe(0);
        expect(draftFileCount(null)).toBe(0);
    });

    it('a paste adds its images only when it carries no text; a drop or a pick adds every file', () => {
        expect(incomingFileCount('paste', { files: files('image/png', 'image/jpeg', 'application/pdf'), text: '' })).toBe(2);
        expect(incomingFileCount('paste', { files: files('image/png'), text: 'a sentence with its picture' })).toBe(0);
        expect(incomingFileCount('drop', { files: files('image/png', 'application/pdf', 'text/plain') })).toBe(3);
        expect(incomingFileCount('pick', { files: files('application/pdf') })).toBe(1);
        expect(incomingFileCount('pick', { files: null })).toBe(0);
    });

    it('refuses only what would go over the limit, and says so in a few words', () => {
        expect(fileLimitRefusal(2, 1)).toBeNull();
        expect(fileLimitRefusal(3, 0)).toBeNull();
        const one = fileLimitRefusal(3, 1);
        expect(one).toMatch(/3 files/);
        expect(one).toMatch(/not added/);
        expect(fileLimitRefusal(2, 2)).toMatch(/3 files/);
    });
});

describe('the guard around the composer', () => {
    it('a pasted image over the limit is refused right there; one under it, and a text paste, go through untouched', () => {
        const refuse = vi.fn();
        let held = 3;
        const guard = composerFileGuard({ count: () => held, refuse });

        const over = paste(files('image/png'));
        guard.onPasteCapture(over);
        expect(over.preventDefault).toHaveBeenCalledTimes(1);
        expect(over.stopPropagation).toHaveBeenCalledTimes(1);
        expect(refuse).toHaveBeenCalledTimes(1);
        expect(refuse.mock.calls[0]![0]).toMatch(/3 files/);

        const text = paste(files('image/png'), 'a sentence');
        guard.onPasteCapture(text);
        expect(text.preventDefault).not.toHaveBeenCalled();
        expect(text.stopPropagation).not.toHaveBeenCalled();

        held = 2;
        const under = paste(files('image/png'));
        guard.onPasteCapture(under);
        expect(under.preventDefault).not.toHaveBeenCalled();
        expect(under.stopPropagation).not.toHaveBeenCalled();
        expect(refuse).toHaveBeenCalledTimes(1);
    });

    it('a drop over the limit is refused, and the composer’s drag highlight is cleared', () => {
        const refuse = vi.fn();
        const dispatched: Array<{ type: string; bubbles: boolean }> = [];
        const target = { dispatchEvent: (e: Event) => { dispatched.push({ type: e.type, bubbles: e.bubbles }); return true; } };
        const guard = composerFileGuard({ count: () => 2, refuse });

        const drop = event({ target, dataTransfer: { files: files('image/png', 'image/png') } });
        guard.onDropCapture(drop);
        expect(drop.preventDefault).toHaveBeenCalledTimes(1);
        expect(drop.stopPropagation).toHaveBeenCalledTimes(1);
        expect(refuse).toHaveBeenCalledTimes(1);
        expect(dispatched).toEqual([{ type: 'dragleave', bubbles: true }]);

        const fits = event({ target, dataTransfer: { files: files('image/png') } });
        guard.onDropCapture(fits);
        expect(fits.stopPropagation).not.toHaveBeenCalled();
        expect(refuse).toHaveBeenCalledTimes(1);
    });

    it('a pick over the limit is refused and the picker is emptied; any other input’s change is untouched', () => {
        const refuse = vi.fn();
        const guard = composerFileGuard({ count: () => 3, refuse });

        const picker = { type: 'file', files: files('application/pdf'), value: 'C:\\fakepath\\a.pdf' };
        const pick = event({ target: picker });
        guard.onChangeCapture(pick);
        expect(pick.stopPropagation).toHaveBeenCalledTimes(1);
        expect(picker.value).toBe('');
        expect(refuse).toHaveBeenCalledTimes(1);

        const typing = event({ target: { type: 'text', value: 'hello' } });
        guard.onChangeCapture(typing);
        expect(typing.stopPropagation).not.toHaveBeenCalled();
        expect(refuse).toHaveBeenCalledTimes(1);
    });
});

describe('the chat composer is guarded', () => {
    it('every composer sits inside the guard, which takes no layout box of its own', () => {
        const thread: ChatThread = { agentId: 'a_lark', name: 'lark', fidelity: 'declared', unread: null, messages: [] };
        const html = renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} />);
        const composers = html.split('data-react-fancy-prompt-input=""').length - 1;
        expect(composers).toBeGreaterThan(0);
        expect(html.split('data-composer-file-limit=""').length - 1).toBe(composers);
        expect(html).toMatch(/data-composer-file-limit="" class="contents"/);
    });
});
