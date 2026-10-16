import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackStore } from '../src/main/feedback-store.js';
import { reportFlush } from '../src/main/store.js';

/**
 * A FLUSH NOBODY AWAITS MUST STILL BE HEARD. Three stores write after a synchronous method with
 * `void this.#flush()`; a flush that failed there was an UNHANDLED REJECTION — on CI (2026-10-12,
 * PR #93) a test's temp directory was removed while an AttentionStore flush was mid-rename, and
 * the suite passed 1529/1529 and still exited 1 with "Errors 2". In the app the same shape is a
 * disk write that failed and said nothing. `reportFlush` is the one way a fire-and-forget flush is
 * written: the failure is reported with the store's name, and never thrown into nowhere.
 */
describe('reportFlush', () => {
    it('reports a failed flush with the store name and the reason, and swallows the rejection', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        let unhandled = 0;
        const onUnhandled = () => { unhandled += 1; };
        process.on('unhandledRejection', onUnhandled);
        try {
            reportFlush(Promise.reject(new Error('disk gone')), 'the feedback store');
            await new Promise((r) => setTimeout(r, 20));
            expect(unhandled).toBe(0);
            expect(error).toHaveBeenCalledTimes(1);
            expect(String(error.mock.calls[0]?.[0])).toMatch(/the feedback store/);
            expect(String(error.mock.calls[0]?.[0])).toMatch(/disk gone/);
        } finally {
            process.off('unhandledRejection', onUnhandled);
            error.mockRestore();
        }
    });

    it('CONTROL: a flush that succeeds reports nothing', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            reportFlush(Promise.resolve(), 'the feedback store');
            await new Promise((r) => setTimeout(r, 20));
            expect(error).not.toHaveBeenCalled();
        } finally {
            error.mockRestore();
        }
    });
});

describe('a store whose fire-and-forget flush fails', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-flush-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });

    it('FeedbackStore.add with its file turned into a directory: the add still returns, the failure is reported, nothing is unhandled', async () => {
        const store = await FeedbackStore.open(dir);
        // The store's file path is now a DIRECTORY: the rename onto it cannot succeed.
        await mkdir(join(dir, 'runtime', 'feedback.json'), { recursive: true });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        let unhandled = 0;
        const onUnhandled = () => { unhandled += 1; };
        process.on('unhandledRejection', onUnhandled);
        try {
            const item = store.add({ workspaceId: 'tynn', agentName: null, kind: 'bug', text: 'the window cannot be moved' });
            expect(item.text).toBe('the window cannot be moved');
            // Windows refuses the rename with EPERM, which writeJsonAtomic retries for ~300 ms before giving up;
            // Linux answers EISDIR at once. The test's deadline must exceed the code's retry budget (the Windows
            // release runner failed a 150 ms wait on 2026-10-12): poll for the report, up to 3 s.
            const until = Date.now() + 3_000;
            while (error.mock.calls.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
            expect(unhandled).toBe(0);
            expect(error).toHaveBeenCalled();
            expect(String(error.mock.calls[0]?.[0])).toMatch(/feedback/);
        } finally {
            process.off('unhandledRejection', onUnhandled);
            error.mockRestore();
        }
    });
});
