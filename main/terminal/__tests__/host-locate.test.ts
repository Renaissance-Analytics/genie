import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
    writePidfile,
    readPidfile,
    deletePidfile,
    pidfileUsable,
    isPidAlive,
    socketPathFor,
    type Pidfile,
} from '../host-locate';
import { PROTOCOL_VERSION } from '../host-protocol';

/**
 * Tier 3 — pidfile + transport-path resolution. The connect-or-spawn decision
 * hinges on pidfileUsable(): a stale (dead pid) or version-mismatched pidfile
 * MUST be judged unusable so the lifecycle spawns a fresh host instead of trying
 * to connect to a corpse.
 */

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-locate-'));
});

afterEach(() => {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
});

describe('pidfile round-trip', () => {
    it('writes then reads back the same pidfile', () => {
        const pf: Pidfile = {
            pid: process.pid,
            socketPath: socketPathFor(dir),
            protocolVersion: PROTOCOL_VERSION,
            startedAt: Date.now(),
        };
        writePidfile(dir, pf);
        expect(readPidfile(dir)).toEqual(pf);
    });

    it('deletePidfile removes it; readPidfile then returns null', () => {
        writePidfile(dir, {
            pid: process.pid,
            socketPath: 'x',
            protocolVersion: PROTOCOL_VERSION,
            startedAt: 1,
        });
        deletePidfile(dir);
        expect(readPidfile(dir)).toBeNull();
    });

    it('returns null for a missing or malformed pidfile', () => {
        expect(readPidfile(dir)).toBeNull();
        fs.writeFileSync(path.join(dir, 'ptyhost.json'), '{ not valid json');
        expect(readPidfile(dir)).toBeNull();
    });
});

describe('isPidAlive', () => {
    it('reports the current process as alive', () => {
        expect(isPidAlive(process.pid)).toBe(true);
    });

    it('reports an almost-certainly-dead pid as not alive', () => {
        // A very high pid that is overwhelmingly unlikely to exist.
        expect(isPidAlive(2_000_000_000)).toBe(false);
    });

    it('treats 0 / negative as not alive', () => {
        expect(isPidAlive(0)).toBe(false);
        expect(isPidAlive(-1)).toBe(false);
    });
});

describe('pidfileUsable', () => {
    it('accepts a live pid + matching version', () => {
        expect(
            pidfileUsable({
                pid: process.pid,
                socketPath: 'x',
                protocolVersion: PROTOCOL_VERSION,
                startedAt: Date.now(),
            }),
        ).toBe(true);
    });

    it('rejects null', () => {
        expect(pidfileUsable(null)).toBe(false);
    });

    it('rejects a dead pid (stale pidfile → spawn fresh)', () => {
        expect(
            pidfileUsable({
                pid: 2_000_000_000,
                socketPath: 'x',
                protocolVersion: PROTOCOL_VERSION,
                startedAt: Date.now(),
            }),
        ).toBe(false);
    });

    it('rejects a protocol-version mismatch (→ spawn fresh)', () => {
        expect(
            pidfileUsable({
                pid: process.pid,
                socketPath: 'x',
                protocolVersion: PROTOCOL_VERSION + 1,
                startedAt: Date.now(),
            }),
        ).toBe(false);
    });
});

describe('socketPathFor', () => {
    it('returns a platform-appropriate transport address', () => {
        const p = socketPathFor(dir);
        if (process.platform === 'win32') {
            expect(p.startsWith('\\\\.\\pipe\\genie-ptyhost-')).toBe(true);
        } else {
            expect(p.endsWith('.sock')).toBe(true);
        }
    });
});
