import { describe, expect, it } from 'vitest';
import {
    engineActionAvailability,
    engineGroupOf,
    engineGroups,
    engineInstalledNote,
    engineStatusLabel,
    engineStatusTone,
    engineUsageNote,
    runtimeDiagnostics,
    stopEngineWarning,
    toolLabel,
    toolRowAction,
    toolUpdateCount,
    toolUpdateRow,
    toolUpdateRows,
    toolUpdateTone,
} from '../workstation-dev-server';
import type { DevEngineInfo, DevWorkstationInfo, ToolUpdate } from '../genie';

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

/**
 * The Dev Tools section (Toolchain Manager, #242 P2). Each row shows an installed
 * host tool's version plus an update-available badge and, when a newer version is
 * known, an Update action. The renderer has no DOM harness, so the row model and
 * badge/action decisions are pinned here; the section wiring lives in settings.tsx.
 */
const upd = (over: Partial<ToolUpdate> = {}): ToolUpdate => ({
    name: 'git',
    installed: '2.40.0',
    latest: '2.45.0',
    updateAvailable: true,
    source: 'package-manager',
    ...over,
});

describe('tool update rows', () => {
    it('labels tools for humans, not by their internal ids', () => {
        expect(toolLabel('claude-code')).toBe('Claude Code');
        expect(toolLabel('node')).toBe('Node.js');
        expect(toolLabel('git')).toBe('Git');
        expect(toolLabel('php')).toBe('PHP');
    });

    it('marks a newer-version-available tool as update-available', () => {
        expect(toolUpdateTone(upd({ updateAvailable: true }))).toBe('update-available');
    });

    it('marks an installed tool with a known latest and no newer version up-to-date', () => {
        expect(
            toolUpdateTone(upd({ installed: '2.45.0', latest: '2.45.0', updateAvailable: false })),
        ).toBe('up-to-date');
    });

    it('marks an installed tool whose latest could not be learned as unknown', () => {
        expect(
            toolUpdateTone(upd({ installed: '2.40.0', latest: undefined, updateAvailable: false, source: 'unknown' })),
        ).toBe('unknown');
    });

    it('marks a tool that is not installed as not-installed', () => {
        expect(toolUpdateTone(upd({ installed: undefined, updateAvailable: false }))).toBe(
            'not-installed',
        );
    });

    it('offers Update only when a newer version is known AND the tool is installed', () => {
        expect(toolRowAction(upd({ installed: '2.40.0', updateAvailable: true }))).toBe('update');
        expect(toolRowAction(upd({ installed: '2.45.0', updateAvailable: false }))).toBe('none');
    });

    /**
     * A row that says "not installed" and offers NOTHING is a dead end — the
     * owner hit exactly that: "it seems i am missing install buttons for docker
     * and git and the agent clis". The wizard owning install was a defensible
     * split right up until the page started reporting installed-ness itself;
     * then it became a page that names a problem and refuses to fix it.
     */
    it('offers Install for a tool that is not on the machine (genie#212)', () => {
        expect(toolRowAction(upd({ name: 'docker', installed: undefined }))).toBe('install');
        expect(toolRowAction(upd({ name: 'git', installed: undefined }))).toBe('install');
        expect(toolRowAction(upd({ name: 'claude-code', installed: undefined }))).toBe('install');
    });

    it('builds a row that carries the version pair, tone and action together', () => {
        expect(toolUpdateRow(upd({ name: 'node', installed: '20.9.0', latest: '20.11.0' }))).toEqual({
            name: 'node',
            label: 'Node.js',
            installed: '20.9.0',
            latest: '20.11.0',
            updateAvailable: true,
            tone: 'update-available',
            action: 'update',
            source: 'package-manager',
        });
    });

    it('maps a whole report and counts only the tools with an update available', () => {
        const updates = [
            upd({ name: 'git', updateAvailable: true }),
            upd({ name: 'node', updateAvailable: false, latest: '20.11.0', installed: '20.11.0' }),
            upd({ name: 'docker', installed: undefined, updateAvailable: false }),
        ];
        expect(toolUpdateRows(updates).map((r) => r.name)).toEqual(['git', 'node', 'docker']);
        expect(toolUpdateCount(updates)).toBe(1);
    });
});

/**
 * MULTI-VERSION (#242 P3). Containers make holding several majors cheap — each
 * (engine, version) is its own image, container and VOLUME — so the manager lets
 * a version be installed BEFORE any workspace asks for it. That is the one action
 * whose availability does not depend on a consumer: pre-pulling postgres 17 while
 * 16 serves today is exactly the point.
 */
describe('engineActionAvailability — install another version', () => {
    it('offers Install for a version whose image is not on this machine, even with no consumer', () => {
        // The multi-version case: no workspace uses postgres 17 yet, and that is
        // precisely when someone wants it downloaded and ready.
        expect(
            engineActionAvailability(
                engine({ recordKey: 'postgres-17', version: '17', installed: false, configured: 0 }),
                true,
            ).canInstall,
        ).toBe(true);
    });

    it('does not offer Install for an image already here', () => {
        expect(
            engineActionAvailability(engine({ installed: true, state: 'stopped' }), true).canInstall,
        ).toBe(false);
    });

    it('does not offer Install without a container runtime', () => {
        // Nothing can be pulled without a runtime to pull it.
        expect(engineActionAvailability(engine({ installed: false }), false).canInstall).toBe(false);
    });

    it('does not offer Install for an engine with no image yet (custom)', () => {
        // A `custom` engine has no image until a workspace names one — there is
        // nothing to pull, and a button that always fails is worse than no button.
        expect(
            engineActionAvailability(engine({ engine: 'custom', image: '' }), true).canInstall,
        ).toBe(false);
    });

    it('still offers Install for a version a workspace configured but never downloaded', () => {
        expect(
            engineActionAvailability(engine({ installed: false, configured: 1 }), true).canInstall,
        ).toBe(true);
    });
});

/**
 * FOLLOWING THE ROW after an action (#242 P3 UX).
 *
 * Installing a version moves it out of the group you clicked in — the tabs key
 * off exactly the state the action changed. A row that silently vanishes from
 * the tab you are looking at reads as "nothing happened" (or worse, "it broke"),
 * so the page has to say what happened AND go where the thing went.
 */
describe('engineGroupOf', () => {
    it('places a running engine in the active group', () => {
        expect(engineGroupOf(engine({ state: 'running', installed: true }))).toBe('active');
    });

    it('places a downloaded-but-idle engine on this machine', () => {
        expect(engineGroupOf(engine({ installed: true }))).toBe('installed');
    });

    it('places a configured-but-absent engine on this machine, not in the catalog', () => {
        expect(engineGroupOf(engine({ configured: 1 }))).toBe('installed');
    });

    it('places an untouched catalog row in available', () => {
        expect(engineGroupOf(engine())).toBe('available');
    });

    it('agrees with engineGroups for every row', () => {
        // One source of truth: the tab a row is IN and the tab we follow it to
        // must never disagree.
        const rows = [
            engine({ recordKey: 'a', state: 'running', installed: true }),
            engine({ recordKey: 'b', installed: true }),
            engine({ recordKey: 'c' }),
        ];
        const groups = engineGroups(rows);
        expect(groups.active.map((e) => e.recordKey)).toEqual(
            rows.filter((e) => engineGroupOf(e) === 'active').map((e) => e.recordKey),
        );
        expect(groups.installed.map((e) => e.recordKey)).toEqual(
            rows.filter((e) => engineGroupOf(e) === 'installed').map((e) => e.recordKey),
        );
        expect(groups.available.map((e) => e.recordKey)).toEqual(
            rows.filter((e) => engineGroupOf(e) === 'available').map((e) => e.recordKey),
        );
    });
});

describe('engineInstalledNote', () => {
    it('names the engine, where it went, and that nothing is running yet', () => {
        const note = engineInstalledNote(engine({ label: 'MySQL', version: '8' }));
        expect(note).toContain('MySQL 8');
        // Where it went — the row moved tabs, so the confirmation has to say so.
        expect(note).toContain('On this machine');
        // A pulled image is not a running engine; claiming otherwise would be a lie
        // the very next glance disproves.
        expect(note).toMatch(/not running|nothing is running/i);
    });

    it('does not append a version to a custom engine', () => {
        expect(engineInstalledNote(engine({ engine: 'custom', label: 'Ollama' }))).toContain(
            'Ollama',
        );
    });
});
