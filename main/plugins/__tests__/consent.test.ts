import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, getPlugin, upsertPlugin, deletePlugin, emptyPluginGrants, setSettings } from '../../db';
import { consentAndEnablePlugin } from '../consent';
import { setQuestionTransport } from '../../ask/force-question';
import type { ForceQuestion, ForceQuestionResult } from '../../mcp/protocol';

/**
 * Install-time CONSENT gate (Phase 1, deliverable #3). Uses the REAL DB and an
 * INJECTED question transport (no BrowserWindow) so the declared→granted flow is
 * exercised end to end:
 *   - a granted subset is recorded (granular §12.1), and the plugin enables,
 *   - a dismissed modal enables NOTHING and grants NOTHING (fail-closed),
 *   - a plugin with no declared capabilities enables silently (no modal), and
 *   - an already-consented plugin re-enables silently.
 */

let dir: string;
let asked = 0;
let lastQuestions: ForceQuestion[] = [];
let nextResult: ForceQuestionResult = { cancelled: true, answers: [] };

const MANIFEST = {
    id: 'test.consent.deck',
    namespace: 'consenttest',
    name: 'Consent Test',
    version: '0.1.0',
    entry: { tools: 'tools.cjs' },
    agent: { guide: 'Use this plugin to create presentation decks.' },
    mcpTools: [
        { name: 'createDeck', description: 'd', inputSchema: { type: 'object' }, run: 'tools', process: 'worker' },
    ],
    capabilities: {
        fs: { scope: 'workspace', extensions: ['.pptx', '.odp'] },
        genieApi: ['openFileForUser'],
    },
};

function seed(id: string, over: Partial<Parameters<typeof upsertPlugin>[0]> = {}): void {
    upsertPlugin({
        id,
        namespace: 'consenttest',
        name: 'Consent Test',
        version: '0.1.0',
        source_type: 'folder',
        install_path: path.join(os.tmpdir(), 'x'),
        enabled: false,
        manifest_json: JSON.stringify(MANIFEST),
        grants: emptyPluginGrants(),
        // Default the GRANT-FLOW scenarios to a trusted plugin so they exercise the
        // capability consent (not the trust gate); the trust-gate tests override.
        trust: 'trusted',
        ...over,
    });
}

function answer(...selected: string[][]): ForceQuestionResult {
    return {
        cancelled: false,
        answers: selected.map((sel) => ({ header: '', question: '', selected: sel, note: '' })),
    };
}

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-consent-'));
    initDatabase(dir);
    setQuestionTransport({
        ask: async (questions) => {
            asked++;
            lastQuestions = questions;
            return nextResult;
        },
    });
});

afterEach(() => {
    for (const id of ['test.consent.deck', 'test.consent.nocaps'])
        try {
            deletePlugin(id);
        } catch {
            /* ignore */
        }
    setSettings({ plugins_developer_mode: 'off' }); // reset dev mode between tests
    asked = 0;
    lastQuestions = [];
});

afterAll(() => {
    setQuestionTransport(null);
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});

describe('consentAndEnablePlugin', () => {
    it('asks one Grant/Deny question per declared capability and records the GRANTED subset', async () => {
        seed('test.consent.deck');
        // Grant fs (q0), deny the Genie API (q1).
        nextResult = answer(['Grant'], ['Deny']);
        const r = await consentAndEnablePlugin('test.consent.deck');

        expect(r.ok).toBe(true);
        expect(r.enabled).toBe(true);
        expect(asked).toBe(1); // one modal, batched questions
        expect(lastQuestions).toHaveLength(2); // fs + genieApi

        const row = getPlugin('test.consent.deck')!;
        expect(row.enabled).toBe(true);
        expect(row.grants.fs.workspace).toBe(true);
        expect(row.grants.genieApi.openFileForUser).not.toBe(true); // denied stays off
    });

    it('DISMISS enables nothing and grants nothing (fail-closed)', async () => {
        seed('test.consent.deck');
        nextResult = { cancelled: true, answers: [] };
        const r = await consentAndEnablePlugin('test.consent.deck');

        expect(r.ok).toBe(false);
        expect(r.enabled).toBe(false);
        const row = getPlugin('test.consent.deck')!;
        expect(row.enabled).toBe(false);
        expect(row.grants.fs.workspace).not.toBe(true);
    });

    it('enables a no-capability plugin silently (no modal)', async () => {
        seed('test.consent.nocaps', {
            id: 'test.consent.nocaps',
            manifest_json: JSON.stringify({
                ...MANIFEST,
                id: 'test.consent.nocaps',
                capabilities: { fs: { scope: 'none' }, network: { hosts: [] }, genieApi: [] },
            }),
        });
        const r = await consentAndEnablePlugin('test.consent.nocaps');
        expect(r.ok).toBe(true);
        expect(r.enabled).toBe(true);
        expect(asked).toBe(0); // nothing to consent → no modal
        expect(getPlugin('test.consent.nocaps')!.enabled).toBe(true);
    });

    it('re-enables an already-consented plugin silently', async () => {
        seed('test.consent.deck', { grants: { fs: { workspace: true }, network: {}, genieApi: {} } });
        const r = await consentAndEnablePlugin('test.consent.deck');
        expect(r.ok).toBe(true);
        expect(asked).toBe(0); // already holds a grant → no re-prompt
        expect(getPlugin('test.consent.deck')!.enabled).toBe(true);
    });

    // --- Phase 3 trust gate --------------------------------------------------

    it('TRUST GATE: refuses an UNTRUSTED plugin outright (no modal, stays off)', async () => {
        seed('test.consent.deck', { trust: 'untrusted' });
        const r = await consentAndEnablePlugin('test.consent.deck');
        expect(r.ok).toBe(false);
        expect(asked).toBe(0);
        expect(getPlugin('test.consent.deck')!.enabled).toBe(false);
    });

    it('TRUST GATE: refuses an UNSIGNED plugin when Developer Mode is OFF', async () => {
        setSettings({ plugins_developer_mode: 'off' });
        seed('test.consent.deck', { trust: 'unsigned' });
        const r = await consentAndEnablePlugin('test.consent.deck');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/Developer Mode/i);
        expect(asked).toBe(0);
        expect(getPlugin('test.consent.deck')!.enabled).toBe(false);
    });

    it('UNSIGNED + Developer Mode: escalated consent, records dev-approval + strips network', async () => {
        setSettings({ plugins_developer_mode: 'on' });
        // An unsigned plugin declaring fs + a network host + a Genie API.
        seed('test.consent.deck', {
            trust: 'unsigned',
            manifest_json: JSON.stringify({
                ...MANIFEST,
                capabilities: {
                    fs: { scope: 'workspace', extensions: ['.pptx'] },
                    network: { hosts: ['api.example.com'] },
                    genieApi: ['openFileForUser'],
                },
            }),
        });
        // q0 = the UNSIGNED enable confirmation; then fs + genieApi (network is NOT
        // offered to an unsigned/restricted plugin).
        nextResult = answer(['Enable'], ['Grant'], ['Grant']);
        const r = await consentAndEnablePlugin('test.consent.deck');

        expect(r.ok).toBe(true);
        expect(asked).toBe(1);
        // First question is the loud unsigned warning; network is never asked.
        expect(lastQuestions[0].header).toBe('Unsigned');
        expect(lastQuestions.some((q) => q.header === 'Network')).toBe(false);

        const row = getPlugin('test.consent.deck')!;
        expect(row.enabled).toBe(true);
        expect(row.dev_approved).toBe(true);
        expect(row.grants.fs.workspace).toBe(true);
        expect(row.grants.network['api.example.com']).not.toBe(true); // restricted: no network
    });

    it('UNSIGNED + Developer Mode: declining the unsigned warning enables nothing', async () => {
        setSettings({ plugins_developer_mode: 'on' });
        seed('test.consent.deck', { trust: 'unsigned' });
        nextResult = answer(['Cancel'], ['Grant']); // decline the unsigned confirm
        const r = await consentAndEnablePlugin('test.consent.deck');
        expect(r.ok).toBe(false);
        expect(getPlugin('test.consent.deck')!.enabled).toBe(false);
    });
});
