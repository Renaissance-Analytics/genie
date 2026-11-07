import { describe, expect, it } from 'vitest';
import type { CrashHeader, CrashRecord, HangNotice } from '../src/core/crash-record.js';
import type { SafeModeView } from '../src/core/safe-mode.js';
import { crashReportHost, type CrashReportDeps } from '../src/main/crash-report-host.js';

/**
 * THE RECORD IN THE REPORT (#1623 review; Tynn story #386). "Send a crash report" on the safe-mode banner AND on the
 * reopened-window notice builds its draft from the latest CrashRecord the host sent (its header, its stalls by stack
 * signature, its exit) — not from the banner's few words alone. With neither safe mode nor a notice there is nothing
 * to report.
 */

const HEADER: CrashHeader = { schema: 1, version: '2.0.0-beta.60', build: '2.0.0-beta.60+abc', os: 'win32', osRelease: '10.0.26200', arch: 'x64', uptimeS: 7200 };
const RECORD: CrashRecord = {
    ...HEADER, kind: 'hang', at: '2026-11-06T10:00:00.000Z', windowPid: 4242, lastBeatAt: '2026-11-06T09:59:30.000Z', lifecycle: [],
    stalls: [{ at: '2026-11-06T09:59:40.000Z', ms: 16600, route: null, stack: 'encode ndjson.js:9 < flush ledger.js:40' }],
    memory: [], agents: [], relaunched: true, hangsRecent: 1,
};
const NOTICE: HangNotice = { at: Date.UTC(2026, 10, 6, 10, 0, 0), hangs: 1, agents: [{ id: 'agent_a', name: 'tynn' }] };
const SAFE: SafeModeView = { active: true, at: Date.UTC(2026, 10, 6, 9, 0), cause: 'it stopped responding', crashLoop: false, agents: [], processes: [], sites: [] };

function reports(over: { view?: SafeModeView | null; record?: CrashRecord | null; notice?: HangNotice | null }) {
    const deps: CrashReportDeps = {
        view: () => over.view ?? null,
        record: () => over.record ?? null,
        notice: () => over.notice ?? null,
        agents: () => [{ id: 'agent_a', name: 'tynn', provider: 'claude' }],
        workspaceNames: () => [],
        genieVersion: '2.0.0-beta.61',
        os: 'linux',
        arch: 'arm64',
        tynnHost: 'https://tynn.test',
        identity: async () => null,
        authHeader: async () => '',
        fetch: async () => ({ status: 500, json: async () => ({}) }),
    };
    return crashReportHost(deps);
}

describe('the draft is built from the record', () => {
    it('safe mode with a record: the record’s header and its stall signatures are in the draft', () => {
        const text = reports({ view: SAFE, record: RECORD }).draft().text;
        expect(text).toContain('Kind: hang');
        expect(text).toContain('Genie 2.0.0-beta.60 on win32 10.0.26200 x64');
        expect(text).toContain('encode ndjson.js:9 < flush ledger.js:40');
    });

    it('the reopened-window notice, with no safe mode: a report of the hang, with its running agents counted', () => {
        const text = reports({ notice: NOTICE, record: RECORD }).draft().text;
        expect(text).toContain('Kind: hang');
        expect(text).toContain('encode ndjson.js:9');
        expect(text).toContain('Agents: 1 agent (claude ×1)');
    });

    it('CONTROL: no safe mode and no notice → nothing to report, record or not', () => {
        expect(reports({ record: RECORD }).draft().text).toBe('');
    });
});
