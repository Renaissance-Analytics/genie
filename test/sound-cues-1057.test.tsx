import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ALERT_KINDS } from '../src/core/alerts.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { RailItem } from '../src/core/rail-view.js';
import {
    addCue, CUE_KINDS, CUE_LOG, CUE_LOOK, cueOfAction, cueOfAlert, cueWanted, latestUnseen, NO_CUES, seeAgent, seeAll, seeCue, seeRoute, unseenCues, workspaceLog,
    type CueKind, type NewCue, type SoundCues,
} from '../src/core/sound-cues.js';
import { readThingSignal, sayThings, type ThingActionSignal } from '../src/core/thing-sounds.js';
import type { WorkspaceDashboardView } from '../src/core/workspace-dashboard.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import { WorkspaceDashboard } from '../src/renderer/components/WorkspaceDashboard.js';
import { ICON_NAMES, registerAppIcons } from '../src/renderer/icons.js';
import { SoundCuesContext, type SoundCuesView } from '../src/renderer/sound-cues-context.js';

/**
 * EVERY GENIE EVENT THAT PLAYS A SOUND ALSO SHOWS (Tynn #1057; the owner, 2026-11-24: "genie event that makes a sound
 * should have a visual representation in the side bar and dashboard and workspace dashboard"; again 2026-11-26: "I still
 * have genie events that emit sounds but with no visual cues … The folder icon in the sidebar items is useless").
 *
 * THE GUARD: every sound event key — each row of Settings → Notifications & sounds (ALERT_KINDS) and the rate-limit
 * alert — has a look (an icon in the app's registry) and is DRAWN in all three surfaces: the sidebar (on its workspace's
 * row, its agent's row, or the Dashboard row for what belongs to no workspace), the Dashboard's activity and the
 * workspace dashboard's. CUE_KINDS is derived from ALERT_KINDS, so a sound added there without a look fails here.
 *
 * Every absence claim has its positive control in the same render (RULES.md: a gauge that reads one as nothing).
 */
registerAppIcons();

const KINDS = CUE_KINDS;
const AGENTS: AgentRow[] = [
    { id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle', duration: '1m', ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: 0, commsAgeSeconds: null, contextUsed: null, contextSize: null } as AgentRow,
    { id: 'a2', name: 'wren', provider: 'codex', workspaceId: 'fancy', fidelity: 'declared', state: 'idle', duration: '1m', ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: 0, commsAgeSeconds: null, contextUsed: null, contextSize: null } as AgentRow,
];
const ws = (id: string): RailItem => ({ id, path: `/w/${id}`, name: id, count: 1, alert: null } as RailItem);
const WORKSPACES = [ws('tynn'), ws('fancy')];
const memory = (view: 'workspaces' | 'agents'): Pick<Storage, 'getItem' | 'setItem'> => {
    const data = new Map([['genie.rail.collapsed', '0'], ['genie.rail.view', view]]);
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
};
const cue = (kind: CueKind, over: Partial<NewCue> = {}): NewCue => ({ id: `c_${kind}`, kind, workspaceId: 'tynn', agentId: 'a1', who: 'atlas', detail: `${kind} happened`, at: 1_000, ...over });
const cuesOf = (...list: NewCue[]): SoundCues => list.reduce<SoundCues>((s, c) => addCue(s, c), NO_CUES);
const within = (view: SoundCuesView, el: ReactElement) => renderToStaticMarkup(<SoundCuesContext.Provider value={view}>{el}</SoundCuesContext.Provider>);

const sidebar = (cues: SoundCues, view: 'workspaces' | 'agents' = 'workspaces') => within({ cues, osAgentId: 'genie' },
    <Sidebar route="genie://dashboard" deckCount={0} workspaces={WORKSPACES} available={['dashboard', 'genie', 'workspace', 'settings']} onNavigate={() => {}} railStorage={memory(view)} agents={AGENTS} />);
/** From an attribute to the end of the item's own button: the row's markup, its icon slot and badge included. */
const rowOf = (html: string, attr: string): string => {
    const at = html.indexOf(attr);
    if (at < 0) return '';
    const open = html.lastIndexOf('<button', at);
    return html.slice(open, html.indexOf('</button>', at) + '</button>'.length);
};
const dashboard = (cues: SoundCues) => within({ cues, osAgentId: 'genie' },
    <Dashboard rows={AGENTS} workspaces={WORKSPACES.map((w) => ({ id: w.id, path: w.path, name: w.id }))} onOpenAgent={() => {}} onAddAgent={() => {}} />);
const VIEW: WorkspaceDashboardView = { strip: [], lanes: [], waiting: [], noAgents: true };
const workspaceDashboard = (cues: SoundCues, workspaceId = 'tynn') => within({ cues, osAgentId: 'genie' },
    <WorkspaceDashboard name={workspaceId} workspaceId={workspaceId} view={VIEW} onOpenAgent={() => {}} onOpenDeckItem={() => {}} onAddAgent={() => {}} />);
const marks = (html: string, kind: CueKind) => (html.match(new RegExp(`data-sound-cue="${kind}"`, 'g')) ?? []).length;

describe('THE GUARD: every sound event key has a visual in the sidebar, the Dashboard and the workspace dashboard', () => {
    it('the keys are every row of Notifications & sounds, and the rate-limit alert (COUNTED)', () => {
        expect(KINDS).toHaveLength(ALERT_KINDS.length + 1);
        for (const k of ALERT_KINDS) expect(KINDS).toContain(k.kind);
        expect(KINDS).toContain('ratelimit');
    });

    it.each(KINDS)('%s has a look: an icon the app registers, and a tone', (kind) => {
        const look = CUE_LOOK[kind];
        expect(look, `${kind} has no look`).toBeDefined();
        expect(ICON_NAMES, `${kind}'s icon is not registered`).toContain(look!.icon);
        expect(['needs', 'bad', 'ok', 'info', 'muted']).toContain(look!.tone);
    });

    it.each(KINDS)('%s, on an agent: its WORKSPACE row and its AGENT row in the sidebar', (kind) => {
        const html = sidebar(cuesOf(cue(kind)));
        expect(marks(rowOf(html, 'data-workspace="tynn"'), kind), 'the workspace row').toBe(1);
        // Control: the other workspace's row is drawn, and has no mark.
        expect(rowOf(html, 'data-workspace="fancy"')).toContain('fancy');
        expect(marks(rowOf(html, 'data-workspace="fancy"'), kind)).toBe(0);
        const agents = sidebar(cuesOf(cue(kind)), 'agents');
        expect(marks(rowOf(agents, 'data-rail-agent="a1"'), kind), 'the agent row').toBe(1);
        expect(rowOf(agents, 'data-rail-agent="a2"')).toContain('wren');
        expect(marks(rowOf(agents, 'data-rail-agent="a2"'), kind)).toBe(0);
    });

    it.each(KINDS)('%s, of no workspace (a shared service, the toolchain, a rate limit): the sidebar’s Dashboard row', (kind) => {
        const html = sidebar(cuesOf(cue(kind, { workspaceId: null, agentId: null, who: null })));
        expect(marks(rowOf(html, 'data-nav="genie://dashboard"'), kind)).toBe(1);
        expect(marks(rowOf(html, 'data-workspace="tynn"'), kind)).toBe(0);
    });

    it.each(KINDS)('%s, of Genie’s own agent: the sidebar’s genie row', (kind) => {
        const html = sidebar(cuesOf(cue(kind, { workspaceId: '__genie__', agentId: 'genie', who: 'genie' })));
        expect(marks(rowOf(html, 'data-nav="genie://agent/genie"'), kind)).toBe(1);
    });

    it.each(KINDS)('%s: an entry in the Dashboard’s activity, unseen', (kind) => {
        const html = dashboard(cuesOf(cue(kind)));
        const strip = html.slice(html.indexOf('data-sound-activity'));
        expect(html).toContain('data-sound-activity');
        expect(strip).toContain(`data-cue-kind="${kind}"`);
        expect(marks(strip, kind)).toBeGreaterThanOrEqual(1);
    });

    it.each(KINDS)('%s: an entry in its workspace dashboard’s activity — and one of no workspace in every workspace’s', (kind) => {
        const own = workspaceDashboard(cuesOf(cue(kind)));
        expect(own).toContain(`data-cue-kind="${kind}"`);
        const machine = workspaceDashboard(cuesOf(cue(kind, { workspaceId: null, agentId: null, who: null })), 'fancy');
        expect(machine).toContain(`data-cue-kind="${kind}"`);
        // Control: another workspace's event is not this one's.
        expect(workspaceDashboard(cuesOf(cue(kind)), 'fancy')).not.toContain(`data-cue-kind="${kind}"`);
    });
});

describe('the sidebar workspace row has no folder icon: its slot is the workspace’s live cue, or nothing', () => {
    it('no folder on any workspace row; the slot shows the icon of its most recent unseen event', () => {
        const html = sidebar(cuesOf(cue('finished', { id: 'c1', at: 1 }), cue('question', { id: 'c2', at: 2 })));
        const tynn = rowOf(html, 'data-workspace="tynn"');
        const fancy = rowOf(html, 'data-workspace="fancy"');
        // Control: the rows carry their names, and lucide's icons are drawn in this render (the Dashboard row's).
        expect(tynn).toContain('tynn');
        expect(rowOf(html, 'data-nav="genie://dashboard"')).toMatch(/lucide-layout-list/);
        for (const row of [tynn, fancy]) expect(row).not.toMatch(/lucide-folder(?![-\w])/);
        // The most recent unseen: the question, in the icon slot (the first icon of the row).
        expect(tynn).toMatch(/data-cue-slot="question"/);
        expect(fancy).not.toMatch(/data-cue-slot="[a-z]/);
        expect(fancy).toContain('data-cue-slot=""');
    });

    it('once seen, the slot is empty again', () => {
        const html = sidebar(seeRoute(cuesOf(cue('finished')), 'genie://workspace/tynn'));
        expect(rowOf(html, 'data-workspace="tynn"')).toContain('data-cue-slot=""');
        expect(marks(rowOf(html, 'data-workspace="tynn"'), 'finished')).toBe(0);
    });
});

describe('a cue stays until seen — the Deck’s rule: dealt with where it is shown, or by going to it', () => {
    const two = () => cuesOf(cue('finished', { id: 'c1', agentId: 'a1', workspaceId: 'tynn', at: 1 }), cue('exits', { id: 'c2', agentId: null, workspaceId: 'fancy', at: 2 }), cue('ratelimit', { id: 'c3', agentId: null, workspaceId: null, at: 3 }));

    it('newest first, unseen, bounded', () => {
        const s = two();
        expect(s.map((c) => c.id)).toEqual(['c3', 'c2', 'c1']);
        expect(s.every((c) => !c.seen)).toBe(true);
        let many: SoundCues = NO_CUES;
        for (let i = 0; i < CUE_LOG + 5; i++) many = addCue(many, cue('runs', { id: `r${i}`, at: i }));
        expect(many).toHaveLength(CUE_LOG);
        expect(many[0]!.id).toBe(`r${CUE_LOG + 4}`);
    });

    it('arriving at a workspace sees its events (its agents’ too); opening an agent sees its own; the Dashboard sees nothing by itself', () => {
        expect(unseenCues(seeRoute(two(), 'genie://dashboard')).map((c) => c.id)).toEqual(['c3', 'c2', 'c1']);
        expect(unseenCues(seeRoute(two(), 'genie://workspace/tynn')).map((c) => c.id)).toEqual(['c3', 'c2']);
        expect(unseenCues(seeRoute(two(), 'genie://agent/a1?tab=stream')).map((c) => c.id)).toEqual(['c3', 'c2']);
        expect(unseenCues(seeAgent(two(), 'a1')).map((c) => c.id)).toEqual(['c3', 'c2']);
        // Nothing to see: the same list back, so nothing re-renders.
        const s = two();
        expect(seeRoute(s, 'genie://dashboard')).toBe(s);
    });

    it('one cleared in place, or all at once', () => {
        expect(unseenCues(seeCue(two(), 'c2')).map((c) => c.id)).toEqual(['c3', 'c1']);
        expect(unseenCues(seeAll(two()))).toEqual([]);
    });

    it('where each shows: a workspace’s newest unseen, an agent’s, the machine’s; a workspace’s log keeps what was seen', () => {
        const s = two();
        expect(latestUnseen(s, { workspaceId: 'tynn' })?.id).toBe('c1');
        expect(latestUnseen(s, { agentId: 'a1' })?.id).toBe('c1');
        expect(latestUnseen(s, 'machine')?.id).toBe('c3');
        expect(latestUnseen(seeAll(s), { workspaceId: 'tynn' })).toBeNull();
        expect(workspaceLog(seeAll(s), 'tynn').map((c) => [c.id, c.seen])).toEqual([['c3', true], ['c1', true]]);
    });

    it('the Dashboard’s activity shows only what is unseen; the workspace dashboard’s shows what was seen too, marked', () => {
        const seen = seeCue(two(), 'c1');
        const dash = dashboard(seen);
        expect(dash).toContain('data-cue-id="c3"');
        expect(dash).not.toContain('data-cue-id="c1"');
        const own = workspaceDashboard(seen);
        expect(own).toMatch(/data-cue-id="c1"[^>]*data-cue-seen="true"|data-cue-seen="true"[^>]*data-cue-id="c1"/);
        expect(own).toMatch(/data-cue-id="c3"[^>]*data-cue-seen="false"|data-cue-seen="false"[^>]*data-cue-id="c3"/);
    });
});

describe('what makes a cue: the same events that play a sound', () => {
    const agents = [{ id: 'a1', name: 'atlas', workspaceId: 'tynn' }];

    it('a row set to a sound is cued — whether or not sounds are on, Do not disturb or a muted volume: the person may be away from the speakers', () => {
        expect(cueWanted('finished', {})).toBe(true); // its own default, Triumphant
        expect(cueWanted('finished', { notification_sounds: false, do_not_disturb: true })).toBe(true);
        expect(cueWanted('reads', {})).toBe(false); // None by default
        expect(cueWanted('reads', { sound_reads: 'synth' })).toBe(true);
        expect(cueWanted('finished', { sound_finished: 'off' })).toBe(false);
    });

    it('an agent’s action is cued on the agent and its workspace; an agentless thing on its workspace, or on none', () => {
        expect(cueOfAction({ agentId: 'a1', kind: 'thumbsup' }, agents, 5, 'x1')).toEqual({ id: 'x1', kind: 'thumbsup', agentId: 'a1', workspaceId: 'tynn', who: 'atlas', detail: 'Ready', at: 5 });
        expect(cueOfAction({ agentId: null, kind: 'exits', workspaceId: 'fancy' }, agents, 5, 'x2')).toMatchObject({ kind: 'exits', agentId: null, workspaceId: 'fancy' });
        expect(cueOfAction({ agentId: null, kind: 'ghci' }, agents, 5, 'x3')).toMatchObject({ kind: 'ghci', agentId: null, workspaceId: null });
        expect(cueOfAction({ agentId: null, kind: 'limit-alert', title: 'Claude: 10% left', body: 'resets 4pm' }, agents, 5, 'x4')).toMatchObject({ kind: 'ratelimit', workspaceId: null, detail: 'Claude: 10% left' });
        // Not a sound: no cue.
        for (const kind of ['account-switch', 'accounts-changed', 'mail-sent', 'done', 'genie']) expect(cueOfAction({ agentId: 'a1', kind }, agents, 5, 'x')).toBeNull();
    });

    it('a Deck or board alert is cued on the agent that raised it; one of no workspace (the toolchain’s) on none', () => {
        expect(cueOfAlert({ kind: 'question', workspace: 'tynn', agent: 'atlas', agentId: 'a1', detail: 'Ship it?' }, 5, 'y1')).toEqual({ id: 'y1', kind: 'question', workspaceId: 'tynn', agentId: 'a1', who: 'atlas', detail: 'Ship it?', at: 5 });
        expect(cueOfAlert({ kind: 'ghsecurity', workspace: '—', agent: 'Toolchain', detail: 'git needs a security update' }, 5, 'y2')).toMatchObject({ workspaceId: null, agentId: null, who: 'Toolchain' });
    });

    it('genie-host says the workspace of what it runs: a process’s, a site’s, a flow’s', () => {
        const fire = { process: (_s: { id: string; state: string; workspaceId?: string }) => {}, sites: () => {}, run: (_id: string, _r: { outcome: 'ran' | 'failed' | 'held' | 'stopped' }) => {} };
        let sites = [{ id: 's1', state: 'running', workspaceId: 'fancy', processIds: ['s1'] }];
        const said: ThingActionSignal[] = [];
        sayThings({
            supervisor: { onChange: (l) => { fire.process = l; } },
            sites: { list: () => sites, onChange: (l) => { fire.sites = l; } },
            engines: null,
            flows: { onRun: (l) => { fire.run = l; }, workspaceOf: (id: string) => (id === 'f1' ? 'tynn' : null) },
        }, (s) => said.push(s));
        fire.process({ id: 'p1', state: 'running', workspaceId: 'tynn' });
        fire.process({ id: 'p1', state: 'exited', workspaceId: 'tynn' });
        sites = [{ id: 's1', state: 'failed', workspaceId: 'fancy', processIds: ['s1'] }];
        fire.sites();
        fire.run('f1', { outcome: 'ran' });
        fire.run('f9', { outcome: 'ran' });
        expect(said).toEqual([
            { agentId: null, kind: 'exits', workspaceId: 'tynn' },
            { agentId: null, kind: 'sitedown', workspaceId: 'fancy' },
            { agentId: null, kind: 'flowdone', workspaceId: 'tynn' },
            { agentId: null, kind: 'flowdone' },
        ]);
        expect(readThingSignal({ agentId: null, kind: 'exits', workspaceId: 'tynn', sound: 'x' })).toEqual({ agentId: null, kind: 'exits', workspaceId: 'tynn' });
        expect(readThingSignal({ agentId: null, kind: 'exits', workspaceId: 7 })).toEqual({ agentId: null, kind: 'exits' });
    });
});

describe('THE WIRING: every sound the window plays goes through the one call that also cues it', () => {
    const app = readFileSync('src/renderer/App.tsx', 'utf8');
    it('App plays no sound of its own: each of its sound paths (the board’s alerts, the toolchain’s, a rate limit, an action) calls soundAndCue', () => {
        expect(app.match(/playAlertSound\(/g) ?? []).toHaveLength(0);
        expect((app.match(/soundAndCue\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
    });
    it('soundAndCue plays and cues, in one place', () => {
        const helper = readFileSync('src/renderer/sound-and-cue.ts', 'utf8');
        expect(helper).toMatch(/playAlertSound\(/);
        expect(helper).toMatch(/cueWanted\(|cue\b/);
    });
});
