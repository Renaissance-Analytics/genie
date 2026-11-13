import { describe, expect, it, vi } from 'vitest';
import { forgetPairedHost } from '../src/renderer/forget-paired-host.js';

const failure = () => new Error('the connection closed: synthetic internal detail\n    at fixture/internal.ts:1:2');
const plain = (refused: ReturnType<typeof vi.fn>) => {
    expect(refused).toHaveBeenCalledTimes(1);
    expect(refused.mock.calls[0]![0]).toBeTypeOf('string');
    expect(refused.mock.calls[0]![0]).not.toMatch(/synthetic|internal\.ts|\n\s*at /);
};

describe('Forget pairing owns the local owner read/write chain (#636)', () => {
    it('keeps the cached pairing until the host confirms that it was forgotten', async () => {
        let complete: (forgot: boolean) => void = () => {};
        const reply = new Promise<boolean>((resolve) => { complete = resolve; });
        let paired = ['host_fixture'];
        const action = forgetPairedHost(() => reply, async () => {}, vi.fn(), () => { paired = []; });
        try { expect(paired).toEqual(['host_fixture']); }
        finally { complete(true); await action; }
        expect(paired).toEqual([]);
    });

    it('owns a rejected forget, reports it plainly and never repeats the uncertain write', async () => {
        const forget = vi.fn(async () => { throw failure(); }); const refresh = vi.fn(async () => {}); const refused = vi.fn();
        await expect(forgetPairedHost(forget, refresh, refused)).resolves.toBeUndefined();
        plain(refused); expect(forget).toHaveBeenCalledTimes(1); expect(refresh).not.toHaveBeenCalled();
    });

    it('owns a rejected follow-up refresh without replaying the completed forget', async () => {
        const forget = vi.fn(async () => true); const refresh = vi.fn(async () => { throw failure(); }); const refused = vi.fn();
        await expect(forgetPairedHost(forget, refresh, refused)).resolves.toBeUndefined();
        plain(refused); expect(forget).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('owns a synchronous forget refusal', async () => {
        const refused = vi.fn();
        await expect(Promise.resolve().then(() => forgetPairedHost(() => { throw failure(); }, async () => {}, refused))).resolves.toBeUndefined();
        plain(refused);
    });

    it('owns a synchronous refresh refusal after a successful forget', async () => {
        const refused = vi.fn(); const forget = vi.fn(async () => true);
        await expect(forgetPairedHost(forget, () => { throw failure(); }, refused)).resolves.toBeUndefined();
        plain(refused); expect(forget).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: successful forget refreshes the actual pairings once without a refusal', async () => {
        const forget = vi.fn(async () => true); const refresh = vi.fn(async () => {}); const refused = vi.fn();
        await expect(forgetPairedHost(forget, refresh, refused)).resolves.toBeUndefined();
        expect(forget).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1); expect(refused).not.toHaveBeenCalled();
    });

    it('CONTROL: an explicit keychain refusal retains its words and still refreshes once', async () => {
        const forget = vi.fn(async () => false); const refresh = vi.fn(async () => {}); const refused = vi.fn();
        await expect(forgetPairedHost(forget, refresh, refused)).resolves.toBeUndefined();
        expect(refused).toHaveBeenCalledWith('This machine’s keychain would not forget that pairing, so it is still kept.');
        expect(forget).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1);
    });
});
