import { expect, it } from 'vitest';
import { deferEvaluation } from '../defer-evaluation';

it('waits for the interrupted main-process stack to unwind before accessing the database', async () => {
    let databaseBusy = true;
    let called = false;
    const result = deferEvaluation(() => {
        called = true;
        if (databaseBusy) throw new Error('database connection is busy executing a query');
        return 42;
    });
    expect(called).toBe(false);
    databaseBusy = false;
    await expect(result).resolves.toBe(42);
});

it('propagates fixture errors instead of hiding or retrying them', async () => {
    await expect(deferEvaluation(() => { throw new Error('fixture failed'); }))
        .rejects.toThrow('fixture failed');
});
