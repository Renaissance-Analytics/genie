import { describe, expect, it } from 'vitest';
import { processTone, processTitle, siteTone, siteTitle, workingAgents } from '../src/core/rail-indicators.js';

/**
 * THE WORKSPACE ROW'S INDICATORS — GENIE 1'S ROW (the owner, 2026-10-19: "I do need an indicator on the workspace row
 * that lets me know what workspaces have working agents. We used to have the agent pulse … the new one should be based
 * on ACP activity, NOT terminals. We do need our bg process and sites indicators as well.")
 *
 * - The PULSE: an agent of this workspace is mid-turn — its session's turn state (core/roster.ts `working`), never
 *   terminal output.
 * - PROCESSES: Genie 1's `wsProcStatus` — none / idle / running / crashed.
 * - SITES: Genie 1's `railSitesTone` — no site: nothing; else running / starting / failed / idle.
 */

const agent = (id: string, workspaceId: string, state: string) => ({ id, workspaceId, state });
const proc = (id: string, workspaceId: string, state: string) => ({ id, workspaceId, state });
const site = (id: string, workspaceId: string, state: string) => ({ id, workspaceId, state });

describe('the pulse: working agents, from their sessions', () => {
    it('counts this workspace’s agents that are mid-turn — not idle, waiting or broken ones, not another workspace’s (COUNTED)', () => {
        const rows = [agent('a', 'tynn', 'working'), agent('b', 'tynn', 'working'), agent('c', 'tynn', 'idle'), agent('d', 'tynn', 'waiting'), agent('e', 'fancy', 'working')];
        expect(workingAgents(rows, 'tynn')).toBe(2);
        expect(workingAgents(rows, 'fancy')).toBe(1);
        expect(workingAgents(rows, 'moic')).toBe(0);
    });
});

describe('processes: Genie 1’s tone', () => {
    it('none without processes; crashed over everything; running over idle; idle when all are stopped', () => {
        expect(processTone([], 'tynn')).toBe('none');
        expect(processTone([proc('p1', 'fancy', 'running')], 'tynn')).toBe('none');
        expect(processTone([proc('p1', 'tynn', 'stopped'), proc('p2', 'tynn', 'exited')], 'tynn')).toBe('idle');
        expect(processTone([proc('p1', 'tynn', 'stopped'), proc('p2', 'tynn', 'restarting')], 'tynn')).toBe('running');
        expect(processTone([proc('p1', 'tynn', 'running'), proc('p2', 'tynn', 'failed')], 'tynn')).toBe('crashed');
    });

    it('the title says how many, and that the click opens them', () => {
        expect(processTitle([proc('p1', 'tynn', 'running'), proc('p2', 'tynn', 'stopped')], 'tynn')).toBe('Background processes (2) — click to open');
        expect(processTitle([], 'tynn')).toBe('No background processes — click to open');
    });
});

describe('sites: Genie 1’s tone', () => {
    it('no site: nothing at all; running beats starting beats failed beats idle', () => {
        expect(siteTone([], 'tynn')).toBeNull();
        expect(siteTone([site('s1', 'fancy', 'running')], 'tynn')).toBeNull();
        expect(siteTone([site('s1', 'tynn', 'stopped'), site('s2', 'tynn', 'running')], 'tynn')).toBe('running');
        expect(siteTone([site('s1', 'tynn', 'restarting'), site('s2', 'tynn', 'failed')], 'tynn')).toBe('starting');
        expect(siteTone([site('s1', 'tynn', 'failed'), site('s2', 'tynn', 'stopped')], 'tynn')).toBe('failed');
        // A site Genie cannot serve is a site that will not come up: shown as failed, not as quietly idle.
        expect(siteTone([site('s1', 'tynn', 'unservable')], 'tynn')).toBe('failed');
        expect(siteTone([site('s1', 'tynn', 'stopped'), site('s2', 'tynn', 'exited')], 'tynn')).toBe('idle');
    });

    it('the title — Genie 1’s words', () => {
        expect(siteTitle([], 'tynn')).toBe('No hosted sites yet — click to open the Site Manager');
        expect(siteTitle([site('s1', 'tynn', 'running'), site('s2', 'tynn', 'failed'), site('s3', 'tynn', 'stopped')], 'tynn')).toBe('3 hosted sites · 1 running · 1 failed — click to open the Site Manager');
    });
});

describe('the rail rows carry them', () => {
    it('railWorkspaces: each row’s working count and both tones; unknown agents stay null (never a 0)', async () => {
        const { railWorkspaces } = await import('../src/core/rail-view.js');
        const rows = [agent('a', 'tynn', 'working'), agent('b', 'fancy', 'idle')] as never;
        const items = railWorkspaces([{ id: 'tynn', path: '/w/tynn', agentsKnown: true }, { id: 'fancy', path: '/w/fancy', agentsKnown: false }], rows, { processes: [proc('p', 'tynn', 'running')], sites: [site('s', 'tynn', 'failed')] });
        expect(items[0]).toMatchObject({ working: 1, processes: 'running', sites: 'failed' });
        expect(items[1]).toMatchObject({ working: null, processes: 'none', sites: null });
    });
});
