import { describe, expect, it } from 'vitest';
import {
    engineActionAvailability,
    engineGroups,
    engineStatusLabel,
    engineStatusTone,
    engineUsageNote,
    runtimeDiagnostics,
    stopEngineWarning,
} from '../workstation-dev-server';
import type { DevEngineInfo, DevWorkstationInfo } from '../genie';

/**
 * WHAT THE WORKSTATION DEV SERVER PAGE DECIDES.
 *
 * The renderer test environment has no DOM, so the page follows the same split
 * the Site Manager uses: every judgement is a pure function here, and the
 * component is the wiring. That is what makes the claims below assertable
 * instead of buried in JSX — and these particular claims are worth pinning,
 * because getting one wrong destroys somebody's data.
 *
 * The hard one is `stop`. On this page a stop is not "turn my thing off": the
 * engine is SHARED, so one click can take six other projects' databases down.
 * A button that does not say so is a trap, and the sentence it says has to be
 * different when nobody is using it (harmless) from when five workspaces are
 * (not harmless). Same for "installed but not running" — several gigabytes of
 * disk that look identical to "not here" unless the page distinguishes them.
 */

const engine = (over: Partial<DevEngineInfo> = {}): DevEngineInfo => ({
    recordKey: 'postgres-16',
    engineKey: 'postgres-16',
    engine: 'postgres',
    version: '16',
    label: 'Postgres',
    summary: 'PostgreSQL.',
    provision: 'sql-database-role',
    image: 'postgres:16-alpine',
    containerName: 'genie-svc-postgres-16',
    installed: false,
    state: 'absent',
    dedicated: false,
    holders: 0,
    configured: 0,
    workspaces: [],
    ...over,
});

const info = (over: Partial<DevWorkstationInfo> = {}): DevWorkstationInfo => ({
    runtime: { kind: 'docker', version: '29.6.1', probes: [] },
    devBase: { image: 'ghcr.io/x/genie-dev-base:1', installed: true, toolchain: [] },
    engines: [],
    ...over,
});

describe('engineStatusTone / engineStatusLabel', () => {
    it('separates running from installed-but-not-running from not-here', () => {
        // Three genuinely different situations, and only one of them means
        // "this is costing me RAM right now".
        expect(engineStatusTone(engine({ state: 'running', installed: true }))).toBe('running');
        expect(engineStatusTone(engine({ state: 'stopped', installed: true }))).toBe('idle');
        expect(engineStatusTone(engine({ installed: true }))).toBe('idle');
        expect(engineStatusTone(engine())).toBe('idle');

        expect(engineStatusLabel(engine({ state: 'running', installed: true }))).toMatch(/running/i);
        // The one worth saying out loud: pulled, never started. Nothing else in
        // Genie reports it, and it is usually the answer to "what is using my disk".
        expect(engineStatusLabel(engine({ installed: true }))).toMatch(/downloaded/i);
        expect(engineStatusLabel(engine())).toMatch(/not on this machine/i);
    });

    it('says a stopped container is stopped, not missing', () => {
        // `stopped` needs "start it"; `absent` needs "it would be downloaded
        // first". Collapsing them makes one of those buttons a lie.
        expect(engineStatusLabel(engine({ state: 'stopped', installed: true }))).toMatch(/stopped/i);
    });
});

describe('engineUsageNote', () => {
    it('names the workspaces rather than counting them', () => {
        const note = engineUsageNote(
            engine({ state: 'running', holders: 2, configured: 3, workspaces: ['web', 'api', 'docs'] }),
        );
        expect(note).toContain('web');
        expect(note).toContain('api');
        expect(note).toContain('docs');
    });

    it('calls out a running engine nobody is holding', () => {
        // An engine carries `restart: unless-stopped`, so a reboot brings it up
        // with zero holders. That is the single most useful row on the page —
        // a database running for nobody — so it gets its own sentence.
        expect(
            engineUsageNote(engine({ state: 'running', holders: 0, configured: 0 })),
        ).toMatch(/no workspace/i);
    });

    it('says nothing at all for an engine that is neither used nor running', () => {
        // A catalog row is an offer, not a status. Decorating it with "0
        // workspaces" is noise on every one of a dozen rows.
        expect(engineUsageNote(engine())).toBeNull();
    });
});

describe('stopEngineWarning', () => {
    it('WARNS with the other workspaces by name when a stop would hit them', () => {
        // The whole risk of the shared model in one string. This is what a
        // confirm dialog says, and it has to name who is affected.
        const warning = stopEngineWarning(
            engine({ state: 'running', holders: 3, workspaces: ['web', 'api', 'docs'] }),
        );
        expect(warning).toBeTruthy();
        expect(warning).toContain('3');
        expect(warning).toMatch(/web/);
    });

    it('does not manufacture a warning when nothing is using it', () => {
        expect(stopEngineWarning(engine({ state: 'running', holders: 0 }))).toBeNull();
    });

    it('still warns for a dedicated engine, which is one workspace’s whole database', () => {
        expect(
            stopEngineWarning(
                engine({ state: 'running', dedicated: true, holders: 1, workspaces: ['lab'] }),
            ),
        ).toMatch(/lab/);
    });
});

describe('engineActionAvailability', () => {
    it('offers stop + logs only for something that is actually up', () => {
        const running = engineActionAvailability(engine({ state: 'running' }), true);
        expect(running).toMatchObject({ canStop: true, canLogs: true, canStart: false });

        const stopped = engineActionAvailability(engine({ state: 'stopped', configured: 1 }), true);
        expect(stopped).toMatchObject({ canStop: false, canLogs: false, canStart: true });
    });

    it('does not offer start for an engine no workspace uses', () => {
        // There is nothing to start: with no consumer there are no credentials
        // to provision and nothing to serve. A button that always fails is worse
        // than no button.
        expect(engineActionAvailability(engine({ state: 'absent' }), true).canStart).toBe(false);
    });

    it('offers nothing at all without a container runtime', () => {
        expect(engineActionAvailability(engine({ state: 'running' }), false)).toMatchObject({
            canStop: false,
            canLogs: false,
            canStart: false,
        });
    });
});

describe('engineGroups', () => {
    it('splits what is ON this machine from what is merely available', () => {
        // Grouped data, grouped in the UI: a flat list of a dozen catalog rows
        // buries the two that are actually running.
        const groups = engineGroups([
            engine({ recordKey: 'postgres-16', state: 'running', installed: true, configured: 1 }),
            engine({ recordKey: 'redis-7', engine: 'redis', version: '7', installed: true }),
            engine({ recordKey: 'mysql-8.4', engine: 'mysql', version: '8.4' }),
        ]);
        expect(groups.active.map((e) => e.recordKey)).toEqual(['postgres-16']);
        expect(groups.installed.map((e) => e.recordKey)).toEqual(['redis-7']);
        expect(groups.available.map((e) => e.recordKey)).toEqual(['mysql-8.4']);
    });

    it('keeps a configured-but-absent engine out of “available”', () => {
        // A workspace asked for it; it just has not run yet. Filing it under
        // "you could add this" would hide a thing that is already set up.
        const groups = engineGroups([engine({ configured: 1, workspaces: ['web'] })]);
        expect(groups.available).toEqual([]);
        expect(groups.installed.map((e) => e.recordKey)).toEqual(['postgres-16']);
    });
});

describe('runtimeDiagnostics', () => {
    it('distinguishes “not installed” from “installed but not running”', () => {
        // Telling someone to install Docker when Docker is installed sends them
        // round a loop they cannot exit — the detection layer already draws this
        // line, and the page must not flatten it back out.
        const stopped = runtimeDiagnostics(
            info({
                runtime: {
                    kind: 'none',
                    reason: 'not-running',
                    installHint: 'Docker is installed but its engine is not running',
                    probes: [{ kind: 'docker', installed: true, running: false }],
                },
            }),
        );
        expect(stopped.usable).toBe(false);
        expect(stopped.headline).toMatch(/not running/i);

        const missing = runtimeDiagnostics(
            info({ runtime: { kind: 'none', reason: 'not-installed', probes: [] } }),
        );
        expect(missing.headline).toMatch(/no container runtime/i);
    });

    it('reports the driving runtime and its version when one is usable', () => {
        const d = runtimeDiagnostics(info());
        expect(d.usable).toBe(true);
        expect(d.headline).toContain('Docker 29.6.1');
    });

    it('surfaces each candidate probe, so “found but unreachable” is visible', () => {
        const d = runtimeDiagnostics(
            info({
                runtime: {
                    kind: 'none',
                    reason: 'not-running',
                    probes: [
                        { kind: 'docker', installed: true, running: false, detail: 'pipe not found' },
                        { kind: 'podman', installed: false, running: false },
                    ],
                },
            }),
        );
        expect(d.probes).toHaveLength(2);
        expect(d.probes[0]).toMatchObject({ kind: 'docker', label: expect.stringMatching(/not running/i) });
        expect(d.probes[1]?.label).toMatch(/not installed/i);
    });
});
