import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPtyLedger, reapLeftoverPtys, writePtyLedger, type PtyLedger, type ReapPorts } from '../src/main/pty-ledger.js';
import type { SpawnFrame } from '../src/main/spawn-host-protocol.js';
import { startSpawnRelay, type RelayChild } from '../src/main/spawn-relay.js';

/**
 * A PTY MUST NOT OUTLIVE ITS OWNER (batch L4, bug B; VM job 76). fancy-pty's helper does not end its shell when its control
 * stream closes, so a spawn host SIGKILLed with its host (vm-smoke's `pkill` of Electron's binary hits both) leaves the
 * helper and its `bash -l` running under init — holding whatever they inherited. The host writes every pty it runs to
 * `runtime/ptys.json` (the relay says when the set changes), and the NEXT host reaps what a dead owner left: only a pid
 * that is still the same process (its start time matches), never one reused by something else, never a live owner's.
 */

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

class FakeChild extends EventEmitter implements RelayChild {
    pid: number;
    connected = true;
    constructor(pid: number, readonly env: Record<string, string>) { super(); this.pid = pid; }
    send(_frame: SpawnFrame): boolean { return true; }
    kill(): boolean { return true; }
    say(frame: SpawnFrame): void { this.emit('message', frame); }
    die(): void { this.connected = false; this.emit('exit', 1, null); }
}

describe('the relay says which ptys it runs', () => {
    it('a pty opened is added, a pty exited is removed, a child that dies takes its ptys out', () => {
        const children: FakeChild[] = [];
        const seen: Array<Array<{ profile: string; id: string; pid: number }>> = [];
        let next = 100;
        startSpawnRelay({
            entry: 'spawn-host.js',
            fork: (_entry, env) => { const c = new FakeChild(next++, env); children.push(c); return c; },
            send: () => {},
            killPid: () => {},
            pidAlive: () => false,
            schedule: () => () => {},
            log: () => {},
            onPtys: (ptys) => { seen.push(ptys.map((p) => ({ ...p }))); },
        });
        const terminals = children[1]!;
        terminals.say({ kind: 'event', channel: 'pty.opened', payload: { id: 't1', pid: 4001 } });
        terminals.say({ kind: 'event', channel: 'pty.opened', payload: { id: 't2', pid: 4002 } });
        expect(seen.at(-1)).toEqual([{ profile: 'terminals', id: 't1', pid: 4001 }, { profile: 'terminals', id: 't2', pid: 4002 }]);
        terminals.say({ kind: 'event', channel: 'pty.exit', payload: { id: 't1', code: 0 } });
        expect(seen.at(-1)).toEqual([{ profile: 'terminals', id: 't2', pid: 4002 }]);
        terminals.die();
        expect(seen.at(-1)).toEqual([]);
    });
});

describe('reapLeftoverPtys', () => {
    function ports(over: Partial<ReapPorts> = {}) {
        const killed: string[] = [];
        const p: ReapPorts = {
            self: 900,
            alive: (pid) => [50, 7, 8, 70].includes(pid),
            startOf: (pid) => ({ 7: '111', 8: '999', 70: '112' } as Record<number, string>)[pid] ?? null,
            childrenOf: (pid) => (pid === 7 ? [70] : []),
            kill: (pid, group) => { killed.push(group ? `-${pid}` : String(pid)); },
            log: () => {},
            ...over,
        };
        return { p, killed };
    }
    const ledger = (owner: number): PtyLedger => ({ owner, ptys: [{ profile: 'terminals', id: 't1', pid: 7, start: '111' }, { profile: 'terminals', id: 't2', pid: 8, start: '222' }] });

    it('a DEAD owner’s pty that is still the same process: its shell’s group, then the helper', () => {
        const { p, killed } = ports({ alive: (pid) => [7, 8, 70].includes(pid) });
        expect(reapLeftoverPtys(ledger(50), p)).toEqual([7]);
        expect(killed).toEqual(['-70', '7']);
    });

    it('a pid reused by another process (its start time differs) is never touched', () => {
        const { p, killed } = ports({ alive: (pid) => [7, 8, 70].includes(pid) });
        reapLeftoverPtys(ledger(50), p);
        expect(killed).not.toContain('8');
    });

    it('a LIVE owner’s ptys, or this host’s own, are left alone', () => {
        const live = ports();
        expect(reapLeftoverPtys(ledger(50), live.p)).toEqual([]);
        expect(live.killed).toEqual([]);
        const own = ports({ alive: (pid) => [7, 8, 70].includes(pid) });
        expect(reapLeftoverPtys(ledger(900), own.p)).toEqual([]);
        expect(own.killed).toEqual([]);
    });

    it('a start time this machine cannot read (or one never recorded) is not a match: nothing is killed on a guess', () => {
        const { p, killed } = ports({ alive: (pid) => [7, 8, 70].includes(pid), startOf: () => null });
        expect(reapLeftoverPtys(ledger(50), p)).toEqual([]);
        expect(killed).toEqual([]);
    });
});

describe('the ledger file', () => {
    it('round-trips, and a file that is not a ledger reads as none', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'pty-ledger-'));
        dirs.push(dir);
        const file = join(dir, 'ptys.json');
        expect(readPtyLedger(file)).toBeNull();
        writePtyLedger(file, { owner: 12, ptys: [{ profile: 'processes', id: 'p1', pid: 33, start: '44' }] });
        expect(readPtyLedger(file)).toEqual({ owner: 12, ptys: [{ profile: 'processes', id: 'p1', pid: 33, start: '44' }] });
        await writeFile(file, '{"owner":"x"}');
        expect(readPtyLedger(file)).toBeNull();
    });
});
