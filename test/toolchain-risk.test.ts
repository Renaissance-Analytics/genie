import { describe, expect, it } from 'vitest';
import { runsOnNode, updateRisk, type ToolchainActivity } from '../src/core/toolchain-risk.js';

/**
 * T3 — THE UPDATE-RISK GUARD (§6.6), pure. Never replace a program something Genie runs is executing: an agent CLI
 * while a session runs on it, Node while anything Genie runs is on it. Warn before Docker, naming the engines it will
 * stop. Every refusal says WHAT is busy; every rule has its idle control.
 */

const IDLE: ToolchainActivity = { sessions: [], processes: [], engines: [] };

describe('agent CLIs — refused only for the sessions running THAT CLI', () => {
    it('a running Claude session blocks updating claude-code, naming it; idle → safe (control)', () => {
        const busy: ToolchainActivity = { ...IDLE, sessions: [{ label: 'atlas', provider: 'claude' }] };
        const r = updateRisk('claude-code', busy, { installed: true });
        expect(r).toMatchObject({ risk: 'blocked', affected: ['atlas'] });
        expect(r.risk !== 'safe' && r.reason).toContain('atlas is running on Claude Code');
        expect(updateRisk('claude-code', IDLE, { installed: true })).toEqual({ risk: 'safe' });
    });

    it('a running Claude session does NOT block Codex (Genie 1’s genie#448); a Codex one does', () => {
        expect(updateRisk('codex', { ...IDLE, sessions: [{ label: 'atlas', provider: 'claude' }] }, { installed: true })).toEqual({ risk: 'safe' });
        expect(updateRisk('codex', { ...IDLE, sessions: [{ label: 'nova', provider: 'codex' }, { label: 'vega', provider: 'codex' }] }, { installed: true })).toMatchObject({ risk: 'blocked', affected: ['nova', 'vega'], reason: expect.stringContaining('nova and vega are running on Codex') });
    });

    it('installing a CLI that is not there replaces nothing — never refused', () => {
        expect(updateRisk('claude-code', { ...IDLE, sessions: [{ label: 'atlas', provider: 'claude' }] }, { installed: false })).toEqual({ risk: 'safe' });
    });
});

describe('node — refused while ANY session or Genie-run node process is up', () => {
    it('a session of either provider blocks it', () => {
        expect(updateRisk('node', { ...IDLE, sessions: [{ label: 'nova', provider: 'codex' }] }, { installed: true })).toMatchObject({ risk: 'blocked', affected: ['nova'] });
    });

    it('a site’s vite dev server blocks it; its php-cgi worker and Caddy do not (control)', () => {
        const processes = [
            { label: 'shop.gen dev server', command: 'npx vite --port 4101' },
            { label: 'app.gen php worker', command: 'php-cgi -b 127.0.0.1:4102' },
            { label: 'app.gen server', command: '/opt/genie/caddy run --config /x/Caddyfile' },
        ];
        const r = updateRisk('node', { ...IDLE, processes }, { installed: true });
        expect(r).toMatchObject({ risk: 'blocked', affected: ['shop.gen dev server'] });
        expect(r.risk !== 'safe' && r.reason).toContain('shop.gen dev server is running on Node');
        expect(updateRisk('node', { ...IDLE, processes: processes.slice(1) }, { installed: true })).toEqual({ risk: 'safe' });
    });

    it('recognises node launchers by their first word, path and Windows extension included', () => {
        expect(runsOnNode('"C:\\Program Files\\nodejs\\node.exe" server.js')).toBe(true);
        expect(runsOnNode('npm.cmd run dev')).toBe(true);
        expect(runsOnNode('/usr/local/bin/pnpm dev')).toBe(true);
        expect(runsOnNode('php artisan serve')).toBe(false);
        expect(runsOnNode('nodemonx')).toBe(false);
    });
});

describe('docker — a warning naming what stops, not a refusal', () => {
    it('running engines → warn with their names; none → safe (control)', () => {
        expect(updateRisk('docker', { ...IDLE, engines: ['genie-svc-postgres', 'redis 7'] }, { installed: true })).toMatchObject({ risk: 'warn', affected: ['genie-svc-postgres', 'redis 7'], reason: expect.stringContaining('stops genie-svc-postgres and redis 7') });
        expect(updateRisk('docker', IDLE, { installed: true })).toEqual({ risk: 'safe' });
    });

    it('other tools are never guarded (git with sessions running → safe)', () => {
        expect(updateRisk('git', { ...IDLE, sessions: [{ label: 'atlas', provider: 'claude' }] }, { installed: true })).toEqual({ risk: 'safe' });
    });
});
