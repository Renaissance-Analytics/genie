import { expect, it } from 'vitest';

async function module() { const path: string = '../scripts/files-content-profile.mjs'; return import(path); }

it('attributes CPU samples to their actual function and preserves idle time separately', async () => {
    const { summarizeCpuProfile } = await module();
    const profile = { startTime: 100, endTime: 10100, nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0 } },
        { id: 2, callFrame: { functionName: 'btoa', url: 'renderer.js', lineNumber: 4 } },
        { id: 3, callFrame: { functionName: 'parse', url: 'renderer.js', lineNumber: 8 } },
        { id: 4, callFrame: { functionName: '(idle)', url: '', lineNumber: 0 } },
    ], samples: [2, 3, 2, 4], timeDeltas: [1000, 2000, 3000, 4000] };
    const result = summarizeCpuProfile(profile);
    expect(result.durationMs).toBe(10); expect(result.sampleMs).toBe(10);
    expect(result.frames).toContainEqual({ name: 'btoa', url: 'renderer.js', line: 4, selfMs: 4, samples: 2 });
    expect(result.frames).toContainEqual({ name: '(idle)', url: '', line: 0, selfMs: 4, samples: 1 });
    // Altering the input changes the reading, rather than returning a fixed total.
    expect(summarizeCpuProfile({ ...profile, timeDeltas: [2000, 2000, 3000, 4000] }).sampleMs).toBe(11);
    expect(() => summarizeCpuProfile({ ...profile, timeDeltas: [1000] })).toThrow(/samples|delta/i);
    expect(() => summarizeCpuProfile({ ...profile, samples: [99, 3, 2, 4] })).toThrow(/node|sample/i);
});

it('counts synchronous encoding work with its receiver, result and thrown error preserved', async () => {
    const { installFilesCounters } = await module();
    let now = 0;
    const scope = { marker: 'own receiver', atob(this: { marker: string }, value: string) { now += 3; if (value === 'bad') throw new Error('original rejection'); return `${this.marker}:${value}`; } };
    const original = scope.atob, counters = installFilesCounters(scope, () => now);
    expect(scope.atob('data')).toBe('own receiver:data');
    expect(() => scope.atob('bad')).toThrow('original rejection');
    expect(counters.summary()).toMatchObject({ atob: { calls: 2, syncMs: 6, wallMs: 6 } });
    counters.reset(); expect(counters.summary()).toEqual({});
    counters.stop(); expect(scope.atob).toBe(original);
});

it('separates asynchronous hash wall time from synchronous invocation time', async () => {
    const { installFilesCounters } = await module();
    let now = 0, finish!: (value: string) => void;
    const scope = { crypto: { subtle: { digest() { now += 2; return new Promise<string>(resolve => { finish = resolve; }); } } } };
    const original = scope.crypto.subtle.digest, counters = installFilesCounters(scope, () => now);
    const pending = scope.crypto.subtle.digest(); now = 10; finish('exact digest');
    expect(await pending).toBe('exact digest');
    expect(counters.summary()).toMatchObject({ 'crypto.subtle.digest': { calls: 1, syncMs: 2, wallMs: 10 } });
    counters.stop(); expect(scope.crypto.subtle.digest).toBe(original);
});

it('instrumentation is optional for absent APIs and does not overwrite a later owner on cleanup', async () => {
    const { installFilesCounters } = await module();
    const scope = { btoa: (value: string) => value }, later = (value: string) => `later:${value}`;
    const counters = installFilesCounters(scope, () => 0); scope.btoa = later;
    counters.stop(); counters.stop(); expect(scope.btoa).toBe(later);
    expect(installFilesCounters({}, () => 0).summary()).toEqual({});
});

it('pairs actual serialized calls/results without recording their arguments or returned content', async () => {
    const { installFilesCounters } = await module();
    let now = 0;
    const scope = { JSON: { parse: JSON.parse, stringify: JSON.stringify } };
    const counters = installFilesCounters(scope, () => now);
    scope.JSON.stringify({ kind: 'call', id: 7, method: 'blob.read', args: ['private contents'] });
    now = 11; scope.JSON.parse('{"kind":"result","id":7,"ok":true,"value":"private result"}');
    expect(counters.calls()).toEqual([{ method: 'blob.read', ms: 11 }]);
    expect(JSON.stringify(counters.calls())).not.toContain('private');
    counters.reset(); expect(counters.calls()).toEqual([]); counters.stop();
});

it('pausing counters excludes the measurement gauge while preserving application calls', async () => {
    const { installFilesCounters } = await module();
    let now = 0;
    const scope = { btoa(value: string) { now += 5; return value; } };
    const counters = installFilesCounters(scope, () => now);
    expect(scope.btoa('application')).toBe('application'); counters.pause();
    expect(scope.btoa('gauge')).toBe('gauge');
    expect(counters.summary()).toEqual({ btoa: { calls: 1, syncMs: 5, wallMs: 5 } });
    counters.resume(); scope.btoa('next application');
    expect(counters.summary()).toEqual({ btoa: { calls: 2, syncMs: 10, wallMs: 10 } }); counters.stop();
});
