import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeployAudit, redactSecrets, type AuditRecord } from '../src/main/deploy-audit.js';

/**
 * DEPLOYMENT D0-1 (Tynn #871; spec §4.7). The deploy audit log is append-only JSONL in host state. Each record carries the
 * previous record's hash, so editing any past line is detectable. It NEVER holds a token, secret value or env var value:
 * the account's own tokens and known key formats are redacted before a line is written.
 */

// A canary: a string shaped like a DigitalOcean token that must never reach the file.
const CANARY = `dop_v1_${'c4a7'.repeat(16)}`;
const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'deploy-audit-')); dirs.push(d); return join(d, 'deploy-audit.jsonl'); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const record = (over: Partial<AuditRecord> = {}): AuditRecord => ({
    actor: { kind: 'person' as const },
    accountId: 'acc-1',
    target: 'tgt-1',
    action: 'apply-step',
    planHash: 'a'.repeat(64),
    result: 'ok',
    ...over,
});

describe('redaction', () => {
    it('positive control: the canary really is in the input it is asked to redact', () => {
        const input = { note: `Authorization: Bearer ${CANARY}` };
        expect(JSON.stringify(input)).toContain(CANARY);
        expect(JSON.stringify(redactSecrets(input, []))).not.toContain(CANARY);
    });

    it('removes the account\'s own token wherever it appears, even in a shape no pattern knows', () => {
        const own = 'plain-looking-token-0123456789';
        const out = JSON.stringify(redactSecrets({ error: `request failed for ${own}`, nested: [{ v: own }] }, [own]));
        expect(out).not.toContain(own);
        expect(out).toContain('[redacted]');
    });

    it('removes known key formats: DigitalOcean, Vercel, AWS access keys', () => {
        const aws = 'AKIAABCDEFGHIJKLMNOP';
        const vercel = `vcp_${'Z9'.repeat(12)}`;
        const out = JSON.stringify(redactSecrets({ a: CANARY, b: `key ${aws} here`, c: vercel }, []));
        for (const s of [CANARY, aws, vercel]) expect(out).not.toContain(s);
    });

    it('drops the values of env vars and secret-named fields entirely', () => {
        const out = redactSecrets({ env: { DB_PASSWORD: 'hunter2', APP_KEY: 'base64:xyz' }, token: 'abc', password: 'p' }, []) as Record<string, unknown>;
        const text = JSON.stringify(out);
        for (const s of ['hunter2', 'base64:xyz', '"abc"', '"p"']) expect(text).not.toContain(s);
        expect(text).toContain('DB_PASSWORD');
    });
});

describe('the log', () => {
    it('the canary never reaches the file, from any field', async () => {
        const file = fresh();
        const audit = new DeployAudit(file, { knownSecrets: () => [CANARY], now: () => 1 });
        await audit.append(record({ result: `failed: 401 for ${CANARY}`, requestId: CANARY, estimate: { note: CANARY } }));
        const text = readFileSync(file, 'utf8');
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toContain(CANARY);
    });

    it('appends one JSON line per record, each carrying the previous record\'s hash', async () => {
        const file = fresh();
        const audit = new DeployAudit(file, { knownSecrets: () => [], now: () => 5 });
        await audit.append(record({ action: 'plan' }));
        await audit.append(record({ action: 'approve' }));
        await audit.append(record({ action: 'apply-step' }));
        const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { prev: string; hash: string; action: string });
        expect(lines.map((l) => l.action)).toEqual(['plan', 'approve', 'apply-step']);
        expect(lines[1].prev).toBe(lines[0].hash);
        expect(lines[2].prev).toBe(lines[1].hash);
        expect(await audit.verify()).toEqual({ ok: true, records: 3 });
    });

    it('a new log instance on an existing file continues the chain', async () => {
        const file = fresh();
        await new DeployAudit(file, { knownSecrets: () => [], now: () => 1 }).append(record({ action: 'one' }));
        const second = new DeployAudit(file, { knownSecrets: () => [], now: () => 2 });
        await second.append(record({ action: 'two' }));
        expect(await second.verify()).toEqual({ ok: true, records: 2 });
    });

    it('editing any past line makes verify() name that line', async () => {
        const file = fresh();
        const audit = new DeployAudit(file, { knownSecrets: () => [], now: () => 9 });
        for (const action of ['plan', 'approve', 'apply-step', 'apply-step']) await audit.append(record({ action }));
        const lines = readFileSync(file, 'utf8').trim().split('\n');
        lines[1] = lines[1].replace('"approve"', '"reject"');
        writeFileSync(file, `${lines.join('\n')}\n`);
        const verdict = await audit.verify();
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.line).toBe(2);
    });

    it('deleting a past line breaks the chain at the line after it', async () => {
        const file = fresh();
        const audit = new DeployAudit(file, { knownSecrets: () => [], now: () => 9 });
        for (const action of ['a', 'b', 'c']) await audit.append(record({ action }));
        const lines = readFileSync(file, 'utf8').trim().split('\n');
        writeFileSync(file, `${[lines[0], lines[2]].join('\n')}\n`);
        const verdict = await audit.verify();
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.line).toBe(2);
    });

    it('appends made at once all land, in order, with an unbroken chain', async () => {
        const file = fresh();
        const audit = new DeployAudit(file, { knownSecrets: () => [], now: () => 3 });
        await Promise.all(Array.from({ length: 20 }, (_, i) => audit.append(record({ action: `n${i}` }))));
        expect(await audit.verify()).toEqual({ ok: true, records: 20 });
    });
});
