import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The image half of terminal paste, on Electron 44's clipboard.
 *
 * Electron 44 rearchitected `clipboard` to the W3C shape: `readImage` and
 * `writeImage` are gone, and `read`/`write` are async and carry `ClipboardItem`s.
 * The old calls do not fail at build time in a way anyone notices — `writeImage`
 * simply is not a function, the `catch` turns that into `ok: false`, and image
 * paste stops working with nothing to say why. So the new calls are pinned here.
 */

const written: unknown[][] = [];
let clipboardItems: Array<{ types: string[]; getType: (t: string) => Promise<Blob> }> = [];

class FakeClipboardItem {
    constructor(public readonly items: Record<string, unknown>) {}
}

const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

vi.mock('electron', () => ({
    clipboard: {
        write: async (items: unknown[]) => void written.push(items),
        read: async () => clipboardItems,
    },
    ClipboardItem: FakeClipboardItem,
    nativeImage: {
        createFromBuffer: (buf: Buffer) => ({
            isEmpty: () => buf.length === 0,
            toDataURL: () => `data:image/png;base64,${buf.toString('base64')}`,
        }),
    },
}));

const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p });

beforeEach(() => {
    written.length = 0;
    clipboardItems = [];
});
afterEach(() => setPlatform(realPlatform));

describe('writeClipboardImagePng on Windows and macOS', () => {
    it('puts the PNG on the clipboard as an image/png ClipboardItem carrying the original bytes', async () => {
        setPlatform('win32');
        const { writeClipboardImagePng } = await import('../clipboard-image');

        const result = await writeClipboardImagePng(PNG_1PX);

        expect(result).toEqual({ ok: true, supported: true });
        expect(written).toHaveLength(1);
        const [item] = written[0] as FakeClipboardItem[];
        const blob = item!.items['image/png'] as Blob;
        expect(blob.type).toBe('image/png');
        expect(Buffer.from(await blob.arrayBuffer()).equals(PNG_1PX)).toBe(true);
    });

    it('reports ok:false, not a throw, when the clipboard write rejects', async () => {
        setPlatform('darwin');
        const electron = await import('electron');
        const spy = vi.spyOn(electron.clipboard, 'write').mockRejectedValueOnce(new Error('denied'));
        const { writeClipboardImagePng } = await import('../clipboard-image');

        await expect(writeClipboardImagePng(PNG_1PX)).resolves.toEqual({ ok: false, supported: true });
        spy.mockRestore();
    });

    it('refuses a buffer that is not an image without touching the clipboard', async () => {
        setPlatform('win32');
        const { writeClipboardImagePng } = await import('../clipboard-image');
        await expect(writeClipboardImagePng(Buffer.alloc(0))).resolves.toEqual({ ok: false, supported: true });
        expect(written).toHaveLength(0);
    });
});

describe('readClipboardImageDataUrl', () => {
    const item = (type: string, bytes: Buffer) => ({
        types: [type],
        getType: async () => new Blob([new Uint8Array(bytes)], { type }),
    });

    it('returns the clipboard image as a PNG data URL', async () => {
        clipboardItems = [item('text/plain', Buffer.from('hello')), item('image/png', PNG_1PX)];
        const { readClipboardImageDataUrl } = await import('../clipboard-image');

        await expect(readClipboardImageDataUrl()).resolves.toBe(`data:image/png;base64,${PNG_1PX.toString('base64')}`);
    });

    it('returns null when the clipboard holds no image', async () => {
        clipboardItems = [item('text/plain', Buffer.from('just text'))];
        const { readClipboardImageDataUrl } = await import('../clipboard-image');
        await expect(readClipboardImageDataUrl()).resolves.toBeNull();
    });

    it('returns null, not a throw, when the clipboard cannot be read', async () => {
        const electron = await import('electron');
        const spy = vi.spyOn(electron.clipboard, 'read').mockRejectedValueOnce(new Error('no display'));
        const { readClipboardImageDataUrl } = await import('../clipboard-image');
        await expect(readClipboardImageDataUrl()).resolves.toBeNull();
        spy.mockRestore();
    });
});
