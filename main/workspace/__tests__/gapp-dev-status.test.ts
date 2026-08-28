import { describe, expect, it } from 'vitest';
import {
    decideGappDevAction,
    formatGappDevStatus,
    gappDevBrief,
    type GappDevStatus,
} from '../gapp-dev-status';

/**
 * What an AGENT is told when it asks whether it is in a GApp Development
 * Workspace (genie#245 follow-on).
 *
 * The feature this file exists for shipped once already with the flag in the
 * database, the chrome on screen and the buttons in Settings — and NO way for an
 * agent to learn any of it. So the thing under test here is not the flag: it is
 * the SENTENCE, and whether somebody who has read none of this source could act
 * on it.
 */

const GDW: GappDevStatus = {
    isGdw: true,
    root: 'C:/work/weather',
    workspaceName: 'Weather',
    tynnProjectId: '01JX',
    app: { name: 'Weather', slug: 'weather', version: '1.2.0' },
    previews: [],
    previewAvailable: true,
};

describe('formatGappDevStatus — the GDW case', () => {
    it('says it IS a GDW, names the folder, and names the app it holds', () => {
        const text = formatGappDevStatus(GDW);

        expect(text).toMatch(/GApp Development Workspace/);
        expect(text).toContain('C:/work/weather');
        expect(text).toContain('Weather');
        expect(text).toContain('1.2.0');
    });

    it('names the tools an agent can act with, not just the state', () => {
        // The failure this replaces was an agent that could see nothing to do.
        // A status that reports a fact and offers no verb repeats it.
        const text = formatGappDevStatus(GDW);

        expect(text).toContain('check');
        expect(text).toContain('preview');
    });

    it('says a folder with no manifest has no app YET, and how to get one', () => {
        const text = formatGappDevStatus({ ...GDW, app: null });

        expect(text).toMatch(/gapp\.json/);
        // A GDW whose folder holds nothing is the START of the loop, not an error.
        expect(text).not.toMatch(/is not a GApp Development Workspace/i);
    });

    it('reports an open preview with its address, so the agent can reach it', () => {
        const text = formatGappDevStatus({
            ...GDW,
            previews: [{ appId: 'weather.preview', homeUrl: 'https://weather.preview.gen/' }],
        });

        expect(text).toContain('https://weather.preview.gen/');
    });

    it('says so when previews cannot be opened here at all', () => {
        // A headless host has no windows. Silence would read as "it did nothing",
        // which is the failure mode this whole feature is a reaction to.
        const text = formatGappDevStatus({ ...GDW, previewAvailable: false });

        expect(text).toMatch(/cannot open a preview|no window/i);
    });
});

describe('formatGappDevStatus — the NOT-a-GDW case', () => {
    const plain: GappDevStatus = {
        isGdw: false,
        root: 'C:/work/other',
        workspaceName: 'Other',
        tynnProjectId: '01JY',
        app: null,
        previews: [],
        previewAvailable: true,
    };

    it('says plainly that it is not one, and who decides', () => {
        const text = formatGappDevStatus(plain);

        expect(text).toMatch(/not a GApp Development Workspace/i);
        // The flag has exactly one home. An agent that does not know that will
        // go looking for a Genie setting to flip, and there isn't one.
        expect(text).toMatch(/Tynn/);
        expect(text).toMatch(/is_gapp/);
    });

    it('does not offer the development verbs it cannot honour — POSITIVE CONTROL', () => {
        const text = formatGappDevStatus(plain);

        // The negative:
        expect(text).not.toMatch(/`preview`/);
        // The control that proves the negative is not passing on an empty string:
        // the same formatter DOES offer them for the GDW above.
        expect(formatGappDevStatus(GDW)).toMatch(/`preview`/);
    });

    it('names the unlinked workspace as unlinked rather than as refused', () => {
        const text = formatGappDevStatus({ ...plain, tynnProjectId: null });

        expect(text).toMatch(/not linked to a Tynn project/i);
    });
});

describe('decideGappDevAction — what the tool will actually do', () => {
    it('always allows `status`, even outside a GDW', () => {
        // "Am I in one" is the question an agent asks BEFORE it knows, so
        // refusing it outside a GDW would make the answer unobtainable.
        expect(decideGappDevAction({ ...GDW, isGdw: false }, 'status').allowed).toBe(true);
        expect(decideGappDevAction(GDW, 'status').allowed).toBe(true);
    });

    it('refuses the development verbs outside a GDW, naming who sets the flag', () => {
        for (const action of ['check', 'preview', 'close-preview'] as const) {
            const decision = decideGappDevAction({ ...GDW, isGdw: false }, action);
            expect(decision.allowed).toBe(false);
            expect(decision.reason).toMatch(/not a GApp Development Workspace/i);
            expect(decision.reason).toMatch(/is_gapp/);
        }
    });

    it('allows them inside a GDW — POSITIVE CONTROL for the refusals above', () => {
        for (const action of ['check', 'preview', 'close-preview'] as const) {
            expect(decideGappDevAction(GDW, action).allowed).toBe(true);
        }
    });

    it('refuses to preview a folder with no manifest, and says what is missing', () => {
        const decision = decideGappDevAction({ ...GDW, app: null }, 'preview');

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('gapp.json');
    });

    it('still allows `check` on a folder with no manifest — that IS the finding', () => {
        // The suite's job is to say what is wrong. Gating it on the thing it
        // reports missing would leave a developer with no way to be told.
        expect(decideGappDevAction({ ...GDW, app: null }, 'check').allowed).toBe(true);
    });

    it('refuses preview on a host that has no window, naming the host as the reason', () => {
        const decision = decideGappDevAction({ ...GDW, previewAvailable: false }, 'preview');

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toMatch(/window/i);
    });

    it('still allows `check` on that same host — POSITIVE CONTROL', () => {
        expect(decideGappDevAction({ ...GDW, previewAvailable: false }, 'check').allowed).toBe(
            true,
        );
    });

    it('refuses everything when the terminal resolves to no workspace at all', () => {
        const nowhere: GappDevStatus = {
            isGdw: false,
            root: null,
            workspaceName: null,
            tynnProjectId: null,
            app: null,
            previews: [],
            previewAvailable: false,
        };

        const decision = decideGappDevAction(nowhere, 'check');
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toMatch(/not attached to a Genie workspace/i);
    });
});

describe('gappDevBrief — the one-liner the workspace map carries', () => {
    it('announces the GDW in a single line an orientation can paste', () => {
        const line = gappDevBrief(GDW);

        expect(line).not.toBeNull();
        expect(line!).toMatch(/GApp Development Workspace/);
        expect(line!.split('\n')).toHaveLength(1);
    });

    it('returns null for an ordinary workspace — nothing to say, no line', () => {
        expect(gappDevBrief({ ...GDW, isGdw: false })).toBeNull();
    });
});
