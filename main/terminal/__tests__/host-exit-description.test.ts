import { describe, expect, it } from 'vitest';
import { describeHostExit, formatHostSpawnRequest } from '../host-diagnostics';

describe('describeHostExit', () => {
    it.each([
        [0, null, 'clean exit 0'],
        [0xc0000005, null, 'access violation'],
        [-1073741819, null, 'access violation'],
        [0xc0000409, null, 'fail-fast/stack overrun'],
        [0xc000013a, null, 'close/Ctrl-C'],
        [null, 'SIGTERM', 'killed by signal SIGTERM'],
        [17, null, 'UNKNOWN'],
        [null, null, 'UNKNOWN'],
    ])('describes %s / %s without guessing', (code, signal, expected) => {
        expect(describeHostExit(code as number | null, signal as string | null)).toContain(expected);
    });
});

it('spawn breadcrumbs include only identity metadata and cannot inject log lines', () => {
    const request = { id: 't1', provider: 'codex', label: 'agent\nforged', env: { TOKEN: 'secret' }, args: ['secret'] };
    const line = formatHostSpawnRequest(request);
    expect(line).toContain('t1');
    expect(line).toContain('codex');
    expect(line).toContain('agent');
    expect(line).not.toContain('\n');
    expect(line).not.toContain('secret');
});
