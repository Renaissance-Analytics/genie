import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());
async function module() { const path: string = '../scripts/files-content-measure-page.mjs'; return import(path); }
it('the VM page measurement uses only the existing visible page bridge and reports exact native content', async () => {
    const content = '雪'.repeat(700_000), open = vi.fn(async () => ({ ok: true, path: 'text.txt', text: content, sha: 'fixture' }));
    const bridge = { files: { open }, workspaces: { settings: vi.fn(async () => ({ ok: true })) } };
    vi.stubGlobal('window', { genieTest: bridge });
    const { measureFilesPage } = await module();
    const result = await measureFilesPage({ method: 'open', args: ['tynn', 'text.txt'] });
    expect(open).toHaveBeenCalledExactlyOnceWith('tynn', 'text.txt');
    expect(result).toMatchObject({ ok: true, bytes: new TextEncoder().encode(content).length, text: content });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
});
it('the page measurement refuses an absent app bridge without opening another door or native fallback', async () => {
    vi.stubGlobal('window', {});
    const { measureFilesPage } = await module();
    await expect(measureFilesPage({ method: 'open', args: ['tynn', 'text.txt'] })).rejects.toThrow(/page bridge|genieTest/i);
});
