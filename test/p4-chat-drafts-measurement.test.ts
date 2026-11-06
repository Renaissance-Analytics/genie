import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllGlobals());
const helper = async () => { const path: string = '../scripts/chat-drafts-measure-page.mjs'; return import(path); };
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
it.each(['readFile', 'save', 'load'])('the %s measurement uses the actual page draft bridge with complete hashes and live clock controls', async method => {
    const bytes = new Uint8Array([0, 1, 255]), body = { v: 1, text: 'paste 雪', pills: [], attachments: [] }, all = { agent_a: body };
    const port = { readFile: vi.fn(async () => bytes), save: vi.fn(async () => {}), load: vi.fn(async () => all) };
    vi.stubGlobal('window', { genieTest: { chatDrafts: port, workspaces: { settings: vi.fn(async () => ({ ok: true })) } } });
    const { measureChatDraftsPage } = await helper();
    const input = { method, args: method === 'readFile' ? ['ref'] : method === 'save' ? ['agent_a', body] : [], workspaceId: 'work' };
    const result = await measureChatDraftsPage(input);
    expect(port[method as keyof typeof port]).toHaveBeenCalledWith(...input.args);
    expect(result.heartbeat.before).toBeGreaterThan(0); expect(result.heartbeat.after).toBeGreaterThan(0); expect(result.concurrentSettings.ok).toBe(true);
    expect(result.sha256).toBe(sha(method === 'readFile' ? bytes : JSON.stringify(method === 'save' ? body : all)));
    if (method === 'load') expect(result.count).toBe(1);
});
it('the draft measurement refuses an absent page bridge, with no native fallback', async () => {
    vi.stubGlobal('window', {}); const { measureChatDraftsPage } = await helper();
    await expect(measureChatDraftsPage({ method: 'load', args: [] })).rejects.toThrow(/genieTest|page bridge/i);
});
