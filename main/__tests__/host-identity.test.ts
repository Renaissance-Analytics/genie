import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostInstallId, _resetHostIdForTest } from '../host-identity';

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'genie-hostid-'));
}

afterEach(() => _resetHostIdForTest());

describe('hostInstallId — stable per-install identity', () => {
    it('mints a UUID once, persists it, and returns it on repeat reads', () => {
        const dir = tmpDir();
        const a = hostInstallId(dir);
        expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(hostInstallId(dir)).toBe(a);
        const onDisk = JSON.parse(
            fs.readFileSync(path.join(dir, 'genie-host-id.json'), 'utf8'),
        ) as { hostId?: string };
        expect(onDisk.hostId).toBe(a);
    });

    it('survives a "process restart" — re-reads the persisted id (stable, not re-minted)', () => {
        const dir = tmpDir();
        const a = hostInstallId(dir);
        _resetHostIdForTest(); // drop the in-memory cache — simulate a fresh process
        expect(hostInstallId(dir)).toBe(a);
    });

    it('is distinct per install dir', () => {
        const a = hostInstallId(tmpDir());
        _resetHostIdForTest();
        const b = hostInstallId(tmpDir());
        expect(a).not.toBe(b);
    });

    it('re-mints when the persisted file is garbled (never blank)', () => {
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, 'genie-host-id.json'), 'not json');
        const id = hostInstallId(dir);
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });
});
