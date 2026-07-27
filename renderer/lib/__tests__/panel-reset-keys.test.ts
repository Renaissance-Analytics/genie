import { describe, expect, it } from 'vitest';
import { panelResetKeys } from '../panel-reset-keys';
import type { TerminalSpec } from '../genie';

function spec(over: Partial<TerminalSpec> = {}): TerminalSpec {
    return {
        id: 'view-1',
        workspace_id: 'ws-a',
        label: 'Code',
        cwd: 'C:/repo',
        shell: null,
        args: [],
        env: {},
        type: 'code',
        meta: {},
        sort_order: 0,
        created_at: '2026-07-01T00:00:00Z',
        last_opened_at: null,
        snapshot_at: null,
        snapshot_bytes: null,
        live_cwd: null,
        enabled: true,
        ...over,
    } as TerminalSpec;
}

describe('panelResetKeys', () => {
    it('is stable while nothing the user navigated changes', () => {
        const s = spec({ meta: { active_file: 'README.md' } });
        expect(panelResetKeys(s, 'ws-a')).toEqual(panelResetKeys(s, 'ws-a'));
    });

    it('changes when the user switches workspace', () => {
        // The bug: a crashed panel keeps its error card forever because spec.id
        // is stable across a workspace switch, so the boundary never resets.
        const s = spec();
        expect(panelResetKeys(s, 'ws-a')).not.toEqual(panelResetKeys(s, 'ws-b'));
    });

    it('changes when the editor switches to another file', () => {
        expect(panelResetKeys(spec({ meta: { active_file: 'a.md' } }), 'ws-a')).not.toEqual(
            panelResetKeys(spec({ meta: { active_file: 'b.md' } }), 'ws-a'),
        );
    });

    it('follows the legacy single-file meta when there are no tabs', () => {
        expect(panelResetKeys(spec({ meta: { file_path: 'a.md' } }), 'ws-a')).not.toEqual(
            panelResetKeys(spec({ meta: { file_path: 'b.md' } }), 'ws-a'),
        );
    });

    it('follows a plugin editor view to its bound file', () => {
        expect(
            panelResetKeys(spec({ type: 'plugin', meta: { file: 'deck.slides' } }), 'ws-a'),
        ).not.toEqual(
            panelResetKeys(spec({ type: 'plugin', meta: { file: 'other.slides' } }), 'ws-a'),
        );
    });

    it('still distinguishes two panels in the same workspace', () => {
        expect(panelResetKeys(spec({ id: 'view-1' }), 'ws-a')).not.toEqual(
            panelResetKeys(spec({ id: 'view-2' }), 'ws-a'),
        );
    });

    it('tolerates a missing active workspace', () => {
        expect(() => panelResetKeys(spec(), null)).not.toThrow();
        expect(panelResetKeys(spec(), null)).toEqual(panelResetKeys(spec(), undefined));
    });
});
