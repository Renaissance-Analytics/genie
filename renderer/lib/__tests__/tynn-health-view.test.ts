import { describe, expect, it } from 'vitest';
import { classifyTynnHealth, type HttpObservation } from '../../../main/mcp/tynn-health';
import {
    TYNN_HEALTH_ROW_TITLES,
    tynnHealthRows,
    tynnHealthSummary,
    tynnHealthTone,
    tynnToneBadgeColor,
    tynnToolsPreview,
} from '../tynn-health-view';

const WS = { workspaceId: 'ws1', workspaceName: 'tynn.ai' };
const URL_OK = 'https://tynn.ai/mcp/tynn';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpObservation {
    return { kind: 'response', status, headers, bodyText: JSON.stringify(body) };
}
const INIT_OK = jsonResponse(200, { jsonrpc: '2.0', id: 1, result: {} });
const tools = (names: string[]) =>
    jsonResponse(200, { jsonrpc: '2.0', id: 2, result: { tools: names.map((name) => ({ name })) } });

const healthy = classifyTynnHealth({
    ...WS,
    url: URL_OK,
    token: 't',
    initialize: INIT_OK,
    toolsList: tools(['create', 'update', 'find']),
});
const broken = classifyTynnHealth({
    ...WS,
    url: 'http://tynn.ai/mcp/tynn',
    token: 't',
    initialize: { kind: 'response', status: 301, headers: { location: URL_OK }, bodyText: '' },
});
const insecure = classifyTynnHealth({
    ...WS,
    url: 'http://tynn.ai/mcp/tynn',
    token: 't',
    initialize: INIT_OK,
    toolsList: tools(['create']),
});
const noTools = classifyTynnHealth({
    ...WS,
    url: URL_OK,
    token: 't',
    initialize: INIT_OK,
    toolsList: tools([]),
});
const unconfigured = classifyTynnHealth({ ...WS, url: null, token: null });

describe('tynnHealthTone', () => {
    it('maps every health state to a distinct tint, and unknown to idle', () => {
        expect(tynnHealthTone(healthy)).toBe('ok');
        expect(tynnHealthTone(insecure)).toBe('warn');
        expect(tynnHealthTone(noTools)).toBe('warn');
        expect(tynnHealthTone(broken)).toBe('bad');
        expect(tynnHealthTone(unconfigured)).toBe('idle');
        // Never probed, and mid-probe: both are "we don't know", not "fine".
        expect(tynnHealthTone(null)).toBe('idle');
        expect(tynnHealthTone({ ...healthy, state: 'checking' })).toBe('idle');
    });

    it('HOLDS the last known tint while re-checking instead of blinking grey', () => {
        // A re-check on a broken workspace must not go quiet for the duration of
        // the request — that reads as "it fixed itself".
        expect(tynnHealthTone(broken, true)).toBe('bad');
        expect(tynnHealthTone(healthy, true)).toBe('ok');
        // With nothing known yet there is no tint to hold.
        expect(tynnHealthTone(null, true)).toBe('idle');
    });
});

describe('tynnHealthSummary', () => {
    it('names the FAILING row, not a generic "error", so the tooltip alone diagnoses it', () => {
        const summary = tynnHealthSummary(broken);
        expect(summary).toContain('Tynn');
        expect(summary).toContain('301');
        expect(summary).toContain('405');
        expect(summary).not.toMatch(/^Tynn — (error|failed|broken)$/i);
    });

    it('reports the tool count when everything is healthy', () => {
        expect(tynnHealthSummary(healthy)).toBe('Tynn — 3 tools available');
    });

    it('prefers the FIRST problem when several rows could speak', () => {
        // Insecure transport AND a working token: the transport warning is the
        // one that predicts the outage, so it must win.
        expect(tynnHealthSummary(insecure)).toContain('plain http://');
    });

    it('says a zero-tool token is connected-but-empty', () => {
        expect(tynnHealthSummary(noTools)).toContain('0 tools');
    });

    it('has a distinct line for unconfigured and for not-yet-checked', () => {
        expect(tynnHealthSummary(unconfigured)).toContain('No Tynn server configured');
        expect(tynnHealthSummary(null)).toBe('Tynn — not checked yet');
        expect(tynnHealthSummary({ ...healthy, state: 'checking' })).toBe('Tynn — checking…');
    });

    it('says checking while a probe is in flight, whatever the last result was', () => {
        expect(tynnHealthSummary(healthy, true)).toBe('Tynn — checking…');
        expect(tynnHealthSummary(broken, true)).toBe('Tynn — checking…');
        expect(tynnHealthSummary(null, true)).toBe('Tynn — checking…');
    });
});

describe('tynnHealthRows', () => {
    it('returns transport, token and permissions in that order with their details', () => {
        const rows = tynnHealthRows(broken);
        expect(rows.map((r) => r.key)).toEqual(['transport', 'auth', 'permission']);
        expect(rows.map((r) => r.title)).toEqual([
            TYNN_HEALTH_ROW_TITLES.transport,
            TYNN_HEALTH_ROW_TITLES.auth,
            TYNN_HEALTH_ROW_TITLES.permission,
        ]);
        expect(rows[0].tone).toBe('bad');
        expect(rows[0].detail).toContain('.mcp.json');
        expect(rows[1].tone).toBe('idle');
    });

    it('carries the tool names on the permission row so the popover can list them', () => {
        const rows = tynnHealthRows(healthy);
        expect(rows[2].tools).toEqual(['create', 'update', 'find']);
        expect(rows[0].tone).toBe('ok');
    });

    it('is empty for a health that was never computed', () => {
        expect(tynnHealthRows(null)).toEqual([]);
    });
});

describe('tynnToneBadgeColor', () => {
    it('gives each tone its own Fancy Badge colour, and never greens a problem', () => {
        expect(tynnToneBadgeColor('ok')).toBe('emerald');
        expect(tynnToneBadgeColor('warn')).toBe('amber');
        expect(tynnToneBadgeColor('bad')).toBe('rose');
        expect(tynnToneBadgeColor('idle')).toBe('zinc');
        const colours = (['ok', 'warn', 'bad', 'idle'] as const).map(tynnToneBadgeColor);
        expect(new Set(colours).size).toBe(4);
    });
});

describe('tynnToolsPreview', () => {
    it('lists short tool sets in full', () => {
        expect(tynnToolsPreview(['create', 'update'], 6)).toBe('create, update');
    });

    it('truncates a long list and says how many are left', () => {
        expect(
            tynnToolsPreview(
                ['create', 'update', 'find', 'next', 'wish', 'project', 'schema', 'repo'],
                6,
            ),
        ).toBe('create, update, find, next, wish, project +2 more');
    });

    it('says none rather than rendering an empty string', () => {
        expect(tynnToolsPreview([], 6)).toBe('none');
    });
});
