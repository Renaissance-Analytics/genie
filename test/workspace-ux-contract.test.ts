import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    BOARD_API,
    BOARD_CLAIMS,
    BOARD_DATA_API,
    BOARD_DRAG,
    BOARD_FIELDS,
    BOARD_GAPS,
    BOARD_LEVELS,
    BOARD_LIVE,
    BOARD_QUICK_ACTIONS,
    BOARD_STATES,
    BOARD_TRANSITIONS,
} from '../src/core/tynn-board.js';
import {
    RELEASES_ANSWER,
    RELEASES_DATA_API,
    RELEASES_FIELDS,
    RELEASES_LIVE,
    RELEASES_QUERY,
    RELEASES_STATES,
    RELEASES_TOP_STORIES,
    RELEASES_TOTALS,
    HOME_ANSWER,
    HOME_API,
    HOME_DASHBOARD,
    HOME_DATA_API,
    HOME_DETAILS,
    HOME_DETAILS_FIELDS,
    HOME_LIVE,
    HOME_QUERY,
    HOME_RANGES,
    HOME_SECTIONS,
    HOME_STATES,
    HOME_WRITE_GUARD,
    WIP_ACTIONS,
    WIP_ANSWER,
    WIP_COUNTS,
    WIP_DATA_API,
    WIP_FIELDS,
    WIP_LENSES,
    WIP_LIVE,
    WIP_QUERY,
    WIP_QUICK_ACTIONS,
    WIP_STATES,
    WIP_TASK_ORDER,
} from '../src/core/tynn-pages.js';
import {
    ISSUE_PRIORITIES,
    ISSUE_TYPE_LOOK,
    ISSUES_ANSWER,
    ISSUES_API,
    ISSUES_CLOSE_VERDICTS,
    ISSUES_CONVERT_STATUSES,
    ISSUES_DATA_API,
    ISSUES_FIELDS,
    ISSUES_FILTERS,
    ISSUES_FORM,
    ISSUES_GAPS,
    ISSUES_LIMIT,
    ISSUES_LIVE,
    ISSUES_QUERY,
    ISSUES_SCOPE,
    ISSUES_STATES,
    ISSUES_TRIAGE,
} from '../src/core/tynn-issues.js';

/**
 * THE WORKSPACE-UX DRIFT WATCHER, Genie's side (genie#1295).
 *
 * The owner, 2026-10-27: "our CI and active spec documentation should include a drift watcher on workspace UX (not just
 * ui). tynn and genie and genie cloud (and supporting repos) are tightly connected and need to stay in sync."
 *
 * contracts/workspace-ux.json says, surface by surface, what a person can DO, what they SEE, and the Tynn API each action
 * uses. tynn.ai owns the contract (the owner, 2026-10-31, q_cb19b598): every published version is canonical in
 * Renaissance-Analytics/tynn.ai at contracts/workspace-ux/<version>/workspace-ux.json, and tynn.ai checks its side there
 * (its routes, its state machines, its web board's own rules) and watches this repo's pin. This checks Genie's: the Tynn tab's declared behaviour in src/core/tynn-board.ts must be the contract's, action for action. An
 * action Genie does not offer yet is named in BOARD_GAPS with the reason — never silently missing.
 */
type Api = { method: string; path: string } | null;
type Action = { id: string; web: string; api: Api; to?: string };
type Board = {
    data: {
        api: { method: string; path: string };
        levels: Record<string, { scope: string; columns: string[] }>;
        fields: Record<string, string[]>;
        claims: Record<string, unknown>;
        drag: Record<string, unknown>;
        transitions: Record<string, Record<string, string[]>>;
        quickActions: Record<string, Record<string, { verb: string; guard?: string }>>;
        live: Record<string, unknown>;
    };
    states: Array<{ id: string }>;
    actions: Action[];
};

const bytes = readFileSync(new URL('../contracts/workspace-ux.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const contract = JSON.parse(bytes) as { $id: string; contract: string; version: string; surfaces: Array<{ id: string } & Board> };
/**
 * The pin beside the copy: the tynn.ai commit that published the version this repo declares against, its path there,
 * and its bytes' hash. tynn.ai is private and this repo's CI is public, so nothing here can fetch it: the pin RECORDS the
 * published bytes' hash and the copy is held to it offline.
 */
const pin = JSON.parse(readFileSync(new URL('../contracts/workspace-ux.pin.json', import.meta.url), 'utf8')) as Record<string, unknown> & {
    repository: string; contract: string; version: string; commit: string; path: string; sha256: string;
};
/** 0.1.0–0.5.0 were published in Civicognita/shared-schemas and brought to tynn.ai byte for byte, so their $id names its tags. */
const LAST_SHARED_SCHEMAS_VERSION = '0.5.0';
const compareVersions = (v: string, w: string) => {
    const p = v.split('.').map(Number);
    const q = w.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const d = (p[i] ?? 0) - (q[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
};
const publishedInSharedSchemas = (v: string) => compareVersions(v, LAST_SHARED_SCHEMAS_VERSION) <= 0;
const board = contract.surfaces.find((s) => s.id === 'board')!;

describe('the contract file', () => {
    it('pins Home, Releases, Issues and WIP to the 0.9.0 contract published by tynn.ai #390', () => {
        expect(pin).toEqual({
            repository: 'Renaissance-Analytics/tynn.ai',
            contract: 'workspace-ux',
            version: '0.9.0',
            commit: '7cd8ef3fc83f365f02bdbf58683d90f930d88ca7',
            path: 'contracts/workspace-ux/0.9.0/workspace-ux.json',
            sha256: '26bccc3973925f1359f4d9e4e88a748e2b225089e62c754c03c75500ba918d2d',
        });
    });

    it('pins a PUBLISHED contract: a commit of Renaissance-Analytics/tynn.ai, the version\'s path there and the sha256 of its bytes', () => {
        expect(pin.repository).toBe('Renaissance-Analytics/tynn.ai');
        expect(pin.contract).toBe('workspace-ux');
        expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(pin.path).toBe(`contracts/workspace-ux/${pin.version}/workspace-ux.json`);
        expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
        // A version is published by merging it to tynn.ai main; there is no tag to name (the shared-schemas tags are gone).
        expect(pin).not.toHaveProperty('tag');
        expect(pin).not.toHaveProperty('tagObject');
    });

    it('is not stale: the copy here is byte for byte the pinned version (it changes in tynn.ai first)', () => {
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.sha256);
        expect(contract.contract).toBe(pin.contract);
        expect(contract.version).toBe(pin.version);
        expect(contract.$id).toBe(publishedInSharedSchemas(pin.version)
            ? `https://raw.githubusercontent.com/Civicognita/shared-schemas/workspace-ux/v${pin.version}/${pin.path}`
            : `https://raw.githubusercontent.com/${pin.repository}/main/${pin.path}`);
        expect(board).toBeDefined();
    });

    it('names each version\'s $id by where it was published', () => {
        expect(publishedInSharedSchemas('0.1.0')).toBe(true);
        expect(publishedInSharedSchemas('0.5.0')).toBe(true);
        expect(publishedInSharedSchemas('0.6.0')).toBe(false);
        expect(publishedInSharedSchemas('0.10.0')).toBe(false);
        expect(publishedInSharedSchemas('1.0.0')).toBe(false);
    });
});

describe('the Tynn tab\'s board, against the contract', () => {
    it('reads the board where the contract says', () => {
        expect(BOARD_DATA_API).toEqual(board.data.api);
    });

    it('calls exactly the contract\'s API for every action it offers, and names every action it does not', () => {
        const ids = new Set(board.actions.map((a) => a.id));
        for (const action of board.actions) {
            const offered = BOARD_API[action.id];
            if (offered) expect({ id: action.id, ...offered }).toEqual({ id: action.id, ...action.api });
            else expect(BOARD_GAPS[action.id], `${action.id} is neither offered nor a named gap`).toMatch(/\S/);
            // An action Tynn has no API for cannot be offered: it is a gap until Tynn adds one.
            if (action.api === null) expect(BOARD_API[action.id]).toBeUndefined();
        }
        // Nothing offered or excused that the contract does not name.
        for (const id of [...Object.keys(BOARD_API), ...Object.keys(BOARD_GAPS)]) expect(ids.has(id), `${id} is not in the contract`).toBe(true);
        // Not both.
        for (const id of Object.keys(BOARD_API)) expect(BOARD_GAPS[id]).toBeUndefined();
    });

    it('shows the contract\'s levels, columns and card fields', () => {
        expect(BOARD_LEVELS).toEqual(board.data.levels);
        expect(BOARD_FIELDS).toEqual(board.data.fields);
    });

    it('drags, gates drops and offers each card\'s next step by the contract\'s rules', () => {
        expect(BOARD_DRAG).toEqual(board.data.drag);
        expect(BOARD_TRANSITIONS).toEqual(board.data.transitions);
        expect(BOARD_QUICK_ACTIONS).toEqual(board.data.quickActions);
    });

    it('claims by the contract\'s rules: the settings it reads, the claim-aware Start, who releases and who assigns', () => {
        expect(BOARD_CLAIMS).toEqual(board.data.claims);
    });

    it('goes live as the contract says: the web board\'s own channel and events, its auth, cursor and changes (0.4.0)', () => {
        // The prose (`about`, `web`, `reconnect`) is for people; everything a client calls or listens to is compared.
        const { about: _about, web: _web, reconnect: _reconnect, ...shape } = board.data.live;
        expect(BOARD_LIVE).toEqual(shape);
    });

    it('has a view for every state the contract names', () => {
        expect([...BOARD_STATES].sort()).toEqual(board.states.map((s) => s.id).sort());
    });

    it('offers every quick action through an API it has (a button with no call behind it is not offered)', () => {
        for (const [kind, steps] of Object.entries(BOARD_QUICK_ACTIONS)) {
            for (const step of Object.values(steps)) expect(BOARD_API[`${kind}.${step.verb}`], `${kind}.${step.verb}`).toBeDefined();
        }
    });
});

describe('the Tynn tab\'s WIP, against the contract (0.6.0)', () => {
    type Wip = {
        data: {
            api: { method: string; path: string };
            query: string[];
            lenses: Record<string, string[]>;
            answer: string[];
            counts: string[];
            fields: Record<string, string[]>;
            taskOrder: string[];
            quickActions: Record<string, Record<string, { verb: string; guard?: string }>>;
            live: Record<string, unknown>;
        };
        states: Array<{ id: string }>;
        actions: Action[];
    };
    const wip = contract.surfaces.find((s) => s.id === 'wip') as unknown as Wip | undefined;

    it('is in the contract', () => {
        expect(wip).toBeDefined();
    });

    it('reads WIP where the contract says, with its query, lenses, counts, fields and task order', () => {
        expect(WIP_DATA_API).toEqual(wip!.data.api);
        expect(WIP_QUERY).toEqual(wip!.data.query);
        expect(WIP_LENSES).toEqual(wip!.data.lenses);
        expect(WIP_ANSWER).toEqual(wip!.data.answer);
        expect(WIP_COUNTS).toEqual(wip!.data.counts);
        expect(WIP_FIELDS).toEqual(wip!.data.fields);
        expect(WIP_TASK_ORDER).toEqual(wip!.data.taskOrder);
        expect(WIP_QUICK_ACTIONS).toEqual(wip!.data.quickActions);
    });

    it('offers exactly the contract\'s actions, through the board\'s API, and each one-click step has one', () => {
        expect([...WIP_ACTIONS].sort()).toEqual(wip!.actions.map((a) => a.id).sort());
        for (const action of wip!.actions) expect({ id: action.id, ...BOARD_API[action.id] }).toEqual({ id: action.id, ...action.api });
        for (const step of Object.values(WIP_QUICK_ACTIONS.task)) expect(WIP_ACTIONS).toContain(`task.${step.verb}`);
    });

    it('goes live as the contract says: the board\'s channel and events, read again on a ring', () => {
        const { about: _about, web: _web, ...shape } = wip!.data.live;
        expect(WIP_LIVE).toEqual(shape);
        expect(WIP_LIVE.channel).toBe(BOARD_LIVE.channel);
    });

    it('has a view for every state the contract names', () => {
        expect([...WIP_STATES].sort()).toEqual(wip!.states.map((s) => s.id).sort());
    });
});

describe('the Tynn tab\'s Issues, against the contract (0.7.0)', () => {
    type Issues = {
        scope: string;
        data: {
            api: { method: string; path: string };
            query: string[];
            filters: { status: string[]; default: string; source: string[] };
            limit: number;
            answer: string[];
            fields: Record<string, string[]>;
            types: string[];
            priorities: string[];
            form: { fields: string[]; required: string[]; defaults: Record<string, string> };
            triage: { guard: string; while: string };
            convert: { versions: string; statuses: string[] };
            close: { verdicts: Record<string, string> };
            live: Record<string, unknown>;
        };
        states: Array<{ id: string }>;
        actions: Action[];
    };
    const issues = contract.surfaces.find((s) => s.id === 'issues') as unknown as Issues | undefined;

    it('is in the contract, on its own pairing scope', () => {
        expect(issues).toBeDefined();
        expect(ISSUES_SCOPE).toBe(issues!.scope);
    });

    it('reads the queue where the contract says, with its filters, answer, fields, types, priorities and limit', () => {
        expect(ISSUES_DATA_API).toEqual(issues!.data.api);
        expect(ISSUES_QUERY).toEqual(issues!.data.query);
        const { status, default: dflt, source } = issues!.data.filters;
        expect(ISSUES_FILTERS).toEqual({ status, default: dflt, source });
        expect(ISSUES_LIMIT).toBe(issues!.data.limit);
        expect(ISSUES_ANSWER).toEqual(issues!.data.answer);
        expect(ISSUES_FIELDS).toEqual(issues!.data.fields);
        expect(Object.keys(ISSUE_TYPE_LOOK)).toEqual(issues!.data.types);
        expect(ISSUE_PRIORITIES).toEqual(issues!.data.priorities);
    });

    it('files, triages, converts and closes by the contract\'s rules', () => {
        const { fields, required, defaults } = issues!.data.form;
        expect(ISSUES_FORM).toEqual({ fields, required, defaults });
        const { guard, while: when } = issues!.data.triage;
        expect(ISSUES_TRIAGE).toEqual({ guard, while: when });
        expect(ISSUES_CONVERT_STATUSES).toEqual(issues!.data.convert.statuses);
        expect(ISSUES_CLOSE_VERDICTS).toEqual(issues!.data.close.verdicts);
    });

    it('calls exactly the contract\'s API for every action it offers, and names every action it does not', () => {
        const ids = new Set(issues!.actions.map((a) => a.id));
        for (const action of issues!.actions) {
            const offered = ISSUES_API[action.id];
            if (offered) expect({ id: action.id, ...offered }).toEqual({ id: action.id, ...action.api });
            else expect(ISSUES_GAPS[action.id], `${action.id} is neither offered nor a named gap`).toMatch(/\S/);
            if (action.api === null) expect(ISSUES_API[action.id]).toBeUndefined();
        }
        for (const id of [...Object.keys(ISSUES_API), ...Object.keys(ISSUES_GAPS)]) expect(ids.has(id), `${id} is not in the contract`).toBe(true);
    });

    it('goes live as the contract says: the queue\'s own channel and events, its auth, cursor and changes', () => {
        const { about: _about, web: _web, reconnect: _reconnect, ...shape } = issues!.data.live;
        expect(ISSUES_LIVE).toEqual(shape);
    });

    it('has a view for every state the contract names', () => {
        expect([...ISSUES_STATES].sort()).toEqual(issues!.states.map((s) => s.id).sort());
    });
});

describe('the Tynn tab\'s Releases, against the contract (0.8.0)', () => {
    type Releases = {
        data: { api: { method: string; path: string }; query: string[]; answer: string[]; fields: Record<string, string[]>; order: string; topStories: number; totals: string[]; live: Record<string, unknown> };
        states: Array<{ id: string }>;
        actions: Action[];
    };
    const releases = contract.surfaces.find((s) => s.id === 'releases') as unknown as Releases | undefined;

    it('is in the contract', () => {
        expect(releases).toBeDefined();
    });

    it('reads Releases where the contract says, with its query, answer, fields, top stories and totals', () => {
        expect(RELEASES_DATA_API).toEqual(releases!.data.api);
        expect(RELEASES_QUERY).toEqual(releases!.data.query);
        expect(RELEASES_ANSWER).toEqual(releases!.data.answer);
        expect(RELEASES_FIELDS).toEqual(releases!.data.fields);
        expect(RELEASES_TOP_STORIES).toBe(releases!.data.topStories);
        expect(RELEASES_TOTALS).toEqual(releases!.data.totals);
        // Genie keeps Tynn's order: it sorts nothing itself.
        expect(releases!.data.order).toBe('newest first');
    });

    it('offers only its read, goes live on the board\'s rings as the contract says, and has a view for every state', () => {
        expect(releases!.actions.map((a) => ({ id: a.id, ...a.api }))).toEqual([{ id: 'releases.list', ...RELEASES_DATA_API }]);
        const { about: _about, web: _web, ...shape } = releases!.data.live;
        expect(RELEASES_LIVE).toEqual(shape);
        expect(RELEASES_LIVE.channel).toBe(BOARD_LIVE.channel);
        expect([...RELEASES_STATES].sort()).toEqual(releases!.states.map((s) => s.id).sort());
    });
});

describe('the Tynn tab\'s Home, against the contract (0.9.0)', () => {
    type Home = {
        data: {
            api: { method: string; path: string }; query: string[]; sections: string[]; ranges: number[]; answer: string[]; dashboard: string[]; details: string[];
            write: { action: string; guard: string; fields: string[] }; live: Record<string, unknown>;
        };
        states: Array<{ id: string }>;
        actions: Action[];
    };
    const home = contract.surfaces.find((s) => s.id === 'home') as unknown as Home | undefined;

    it('is in the contract', () => {
        expect(home).toBeDefined();
    });

    it('reads the Home where the contract says, with its query, sections, ranges, answer, dashboard and details', () => {
        expect(HOME_DATA_API).toEqual(home!.data.api);
        expect(HOME_QUERY).toEqual(home!.data.query);
        expect(HOME_SECTIONS).toEqual(home!.data.sections);
        expect(HOME_RANGES.map(Number)).toEqual(home!.data.ranges);
        expect(HOME_ANSWER).toEqual(home!.data.answer);
        expect(HOME_DASHBOARD).toEqual(home!.data.dashboard);
        expect(HOME_DETAILS).toEqual(home!.data.details);
    });

    it('saves the Details at exactly the contract\'s door, with the web form\'s fields, behind its guard', () => {
        expect(home!.actions.map((a) => a.id)).toEqual(Object.keys(HOME_API));
        for (const action of home!.actions) expect({ id: action.id, ...HOME_API[action.id] }).toEqual({ id: action.id, ...action.api });
        expect(home!.data.write.action).toBe('details.update');
        expect([...HOME_DETAILS_FIELDS]).toEqual(home!.data.write.fields);
        expect(HOME_WRITE_GUARD).toBe(home!.data.write.guard);
    });

    it('goes live on the board\'s rings as the contract says, with a view for every state', () => {
        const { about: _about, web: _web, ...shape } = home!.data.live;
        expect(HOME_LIVE).toEqual(shape);
        expect(HOME_LIVE.channel).toBe(BOARD_LIVE.channel);
        expect([...HOME_STATES].sort()).toEqual(home!.states.map((s) => s.id).sort());
    });
});
