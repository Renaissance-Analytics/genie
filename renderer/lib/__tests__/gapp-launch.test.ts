import { describe, expect, it } from 'vitest';
import {
    gappLaunchLabel,
    gappLaunchTarget,
    gappLaunchTargets,
    type GappLaunchRow,
} from '../gapp-launch';

/**
 * "How do I launch a GApp from a GDW?" (genie#245 follow-on)
 *
 * The honest answer was: open Workspace Settings, scroll to a section that
 * appears for some workspaces and not others, press Preview. Two clicks if you
 * already know where to look, and unfindable if you do not — there was no rail
 * affordance and no command-palette entry.
 *
 * This is the shared judgement behind both of the new ones, kept out of the
 * components because the renderer's test environment has no DOM: a decision
 * inside a component is a decision nobody checks.
 */

const GDW: GappLaunchRow = {
    id: 'ws-1',
    project_name: 'Weather',
    path: 'C:/work/weather',
    gapp_dev: 1,
};

describe('which workspaces offer a launch', () => {
    it('offers one for a GApp Development Workspace', () => {
        expect(gappLaunchTargets([GDW]).map((t) => t.id)).toEqual(['ws-1']);
    });

    it('offers none for an ordinary workspace — POSITIVE CONTROL', () => {
        expect(gappLaunchTargets([{ ...GDW, gapp_dev: 0 }])).toEqual([]);
        // The control: the same call DOES produce a target for the GDW above, so
        // the empty result is a filter and not a broken reader.
        expect(gappLaunchTargets([GDW])).toHaveLength(1);
    });

    it('offers none for a workspace that is a place an app RUNS', () => {
        // Precedence: `app`/`app-preview` outrank the GDW flag, and a workspace
        // hosting an INSTALLED app is not where that app is built. Launching a
        // preview there would open a second copy of somebody else's app.
        expect(gappLaunchTargets([{ ...GDW, app_kind: 'app' }])).toEqual([]);
        expect(gappLaunchTargets([{ ...GDW, app_kind: 'app-preview' }])).toEqual([]);
    });

    it('offers one for a workspace installed for DEVELOPMENT and marked a GDW', () => {
        // `app-dev` ranks BELOW the GDW flag: when a workspace is both, the
        // human's declaration says more than the install route taken.
        expect(gappLaunchTargets([{ ...GDW, app_kind: 'app-dev' }]).map((t) => t.id)).toEqual([
            'ws-1',
        ]);
    });

    it('skips a GDW with no folder — there would be nothing to launch', () => {
        expect(gappLaunchTargets([{ ...GDW, path: '' }])).toEqual([]);
    });

    it('carries the folder, so a caller never has to re-resolve it', () => {
        expect(gappLaunchTargets([GDW])[0]!.path).toBe('C:/work/weather');
    });
});

describe('the single-row question the workspace row asks', () => {
    it('answers the same as the list form, so the two affordances agree', () => {
        // The row asks about itself and the palette asks about all of them. Two
        // readers that decided separately would be two chances to offer a launch
        // in one place and not the other.
        const rows: GappLaunchRow[] = [
            GDW,
            { ...GDW, id: 'ws-2', gapp_dev: 0 },
            { ...GDW, id: 'ws-3', app_kind: 'app' },
        ];

        expect(rows.map((r) => gappLaunchTarget(r)?.id ?? null)).toEqual(['ws-1', null, null]);
        expect(gappLaunchTargets(rows).map((t) => t.id)).toEqual(['ws-1']);
    });
});

describe('what the launch is called', () => {
    it('names the workspace and says what it launches', () => {
        const label = gappLaunchLabel(GDW);

        expect(label).toContain('Weather');
        expect(label).toMatch(/launch/i);
        // Someone in the palette typing "app" should find it.
        expect(label).toMatch(/Genie App/);
    });
});
