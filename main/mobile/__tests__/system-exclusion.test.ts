import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    confineCwdToWorkspace,
    processServable,
    terminalServable,
    type MobileDataDeps,
} from '../api';
import {
    markDesktopRuntime,
    markHeadlessRuntime,
    _resetRuntimeModeForTest,
} from '../../runtime-mode';

/**
 * genie-cloud (headless) must NEVER serve the synthetic System workspace, and
 * every pty it spawns must stay inside the workspace folder (Part B). These
 * drive the pure predicates the mobile surface + `/ws/term` attach call.
 */

afterEach(() => _resetRuntimeModeForTest());

const WS = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj';

/** A stub surface with one real workspace `w1`, one workspace-bound terminal
 *  `t-real`, one SYSTEM terminal `t-sys` (workspace_id null), a real process
 *  `p-real`, and a System process `p-sys` (workspaceId null). */
function deps(): MobileDataDeps {
    return {
        listWorkspaces: () => [{ id: 'w1', project_name: 'Proj', path: WS }],
        listTerminalSpecs: () => [
            { id: 't-real', workspace_id: 'w1', label: 't', type: 'terminal', cwd: WS, live_cwd: null },
            { id: 't-sys', workspace_id: null, label: 'sys', type: 'terminal', cwd: WS, live_cwd: null },
            { id: 't-ghost', workspace_id: 'gone', label: 'g', type: 'terminal', cwd: WS, live_cwd: null },
        ],
        listAllProcesses: () => [
            { id: 'p-real', kind: 'process', label: 'p', command: 'x', workspace: 'Proj', workspaceId: 'w1', status: 'running', autostart: false },
            { id: 'p-sys', kind: 'process', label: 's', command: 'y', workspace: 'System', workspaceId: null, status: 'running', autostart: false },
        ],
    } as unknown as MobileDataDeps;
}

describe('terminalServable', () => {
    it('desktop serves every terminal (unchanged)', () => {
        markDesktopRuntime();
        const d = deps();
        expect(terminalServable(d, 't-real')).toBe(true);
        expect(terminalServable(d, 't-sys')).toBe(true);
    });

    it('headless serves ONLY real-workspace terminals — never System/unattached', () => {
        markHeadlessRuntime();
        const d = deps();
        expect(terminalServable(d, 't-real')).toBe(true);
        expect(terminalServable(d, 't-sys')).toBe(false); // System (null workspace)
        expect(terminalServable(d, 't-ghost')).toBe(false); // removed workspace
        expect(terminalServable(d, 'nope')).toBe(false); // unknown id → fail-closed
    });
});

describe('processServable', () => {
    it('headless serves ONLY real-workspace processes', () => {
        markHeadlessRuntime();
        const d = deps();
        expect(processServable(d, 'p-real')).toBe(true);
        expect(processServable(d, 'p-sys')).toBe(false);
        expect(processServable(d, 'nope')).toBe(false);
    });
});

describe('confineCwdToWorkspace', () => {
    it('keeps a relative subfolder inside the workspace', () => {
        expect(confineCwdToWorkspace(WS, 'repos/app')).toBe(path.resolve(WS, 'repos/app'));
    });
    it('clamps an absolute path back to the workspace root', () => {
        const escape = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
        expect(confineCwdToWorkspace(WS, escape)).toBe(path.resolve(WS));
    });
    it('clamps a `..` escape back to the workspace root', () => {
        expect(confineCwdToWorkspace(WS, '../../elsewhere')).toBe(path.resolve(WS));
    });
    it('empty/missing cwd is the workspace root', () => {
        expect(confineCwdToWorkspace(WS)).toBe(path.resolve(WS));
        expect(confineCwdToWorkspace(WS, '   ')).toBe(path.resolve(WS));
    });
});
