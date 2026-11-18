import { describe, expect, it, vi } from 'vitest';
import { incomingFileRefusal } from '../src/core/composer.js';
import { composerFileGuard, type FileGuardEvent } from '../src/renderer/components/ComposerFileLimit.js';

/**
 * A FILE OVER A LIMIT IS REFUSED WHEN IT IS ADDED, NOT AT SEND (Tynn #829). Any type of file can now be sent, so the
 * limits that remain (25 MB per file, no executables; the 3-file cap is #2007's) are said at the paste, the drop or the
 * pick, with #2007's toast: nothing of the file enters the draft and the layout does not move.
 */
const MB = 1024 * 1024;
type F = { name: string; size: number; type: string };
const f = (name: string, size: number, type = ''): F => ({ name, size, type });

function event(over: Partial<FileGuardEvent> = {}) {
    const e = { target: {}, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over };
    return e as FileGuardEvent & { preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn> };
}

describe('the limits a file is checked against as it is added', () => {
    it('over 25 MB, or an executable, is refused with its name; a docx, a pdf, a zip under the limit are not', () => {
        expect(incomingFileRefusal('drop', { files: [f('big.zip', 25 * MB + 1)] })).toMatch(/big\.zip.*25 MB/);
        expect(incomingFileRefusal('pick', { files: [f('setup.exe', 1000)] })).toMatch(/setup\.exe.*executable/);
        expect(incomingFileRefusal('drop', { files: [f("Wish's Wonders Letterhead.docx", 52 * 1024), f('a.pdf', 3 * MB), f('b.zip', 25 * MB)] })).toBeNull();
    });

    it('a paste that carries text adds no file, so it is never refused for one', () => {
        expect(incomingFileRefusal('paste', { files: [f('image.png', 30 * MB, 'image/png')], text: 'a sentence' })).toBeNull();
        expect(incomingFileRefusal('paste', { files: [f('image.png', 30 * MB, 'image/png')], text: '' })).toMatch(/25 MB/);
    });
});

describe('the guard refuses it right there', () => {
    it('a drop of a 26 MB file is stopped and toasted; CONTROL: the 52 KB docx goes through untouched', () => {
        const refuse = vi.fn();
        const guard = composerFileGuard({ count: () => 0, refuse });
        const big = event({ dataTransfer: { files: [f('big.zip', 26 * MB)] } });
        guard.onDropCapture(big);
        expect(big.preventDefault).toHaveBeenCalledTimes(1);
        expect(big.stopPropagation).toHaveBeenCalledTimes(1);
        expect(refuse).toHaveBeenCalledTimes(1);
        expect(refuse.mock.calls[0]![0]).toMatch(/big\.zip/);

        const letterhead = event({ dataTransfer: { files: [f("Wish's Wonders Letterhead.docx", 52 * 1024)] } });
        guard.onDropCapture(letterhead);
        expect(letterhead.preventDefault).not.toHaveBeenCalled();
        expect(letterhead.stopPropagation).not.toHaveBeenCalled();
        expect(refuse).toHaveBeenCalledTimes(1);
    });

    it('a pick of an executable is refused and the picker emptied', () => {
        const refuse = vi.fn();
        const guard = composerFileGuard({ count: () => 0, refuse });
        const picker = { type: 'file', files: [f('setup.exe', 1000)], value: 'C:\\fakepath\\setup.exe' };
        const pick = event({ target: picker });
        guard.onChangeCapture(pick);
        expect(pick.stopPropagation).toHaveBeenCalledTimes(1);
        expect(picker.value).toBe('');
        expect(refuse.mock.calls[0]![0]).toMatch(/executable/);
    });
});
