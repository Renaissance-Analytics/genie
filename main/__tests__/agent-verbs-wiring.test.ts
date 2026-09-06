import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Two verbs an AGENT had and a HUMAN did not — genie#463 and #474.
 *
 * Both issues are the same gap seen twice: `runAgent switchTui` and
 * `runAgent stop` were fully built over MCP, and the renderer could reach
 * neither. The fix is not only that the controls now exist, it is that they go
 * through the SAME rules and the SAME verbs the agent-facing side does. That is
 * what this file pins, because it is the part a later edit can quietly undo:
 *
 *  - the human's switch consults `decideTuiSwitch` + `agentAllowedTuis`, exactly
 *    as `host-tools.ts` does, so an `AGENT.md` that restricts `tuis:` binds a
 *    person's click as well as an agent's tool call;
 *  - the human's stop reaches `agents:stop`, and never `agents:delete`.
 *
 * SOURCE-LEVEL, like `agent-cap-ipc.test.ts` next door, because what is being
 * pinned is the presence or absence of a CALL SITE. `main/ipc.ts` bootstraps
 * Electron on import, so there is no cheap behavioural harness for it — and a
 * behavioural test can only ever exercise the call sites that exist, while the
 * failure mode here is somebody adding or removing one.
 */

const mainDir = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(mainDir, rel), 'utf8');

describe('the human switch is held to the agent’s own rule (genie#463)', () => {
    it('POSITIVE CONTROL: the AGENT’s path really does apply it', () => {
        // If `host-tools.ts` ever stopped consulting these, the assertions
        // below would be pinning agreement with nothing.
        const hostTools = read('mcp/host-tools.ts');
        expect(hostTools).toContain('decideTuiSwitch');
        expect(hostTools).toContain('agentAllowedTuis');
        expect(hostTools).toContain("case 'switchTui'");
    });

    it('the RENDERER’s path applies the same two, in agentRecordAddRuntime', () => {
        const ipc = read('ipc.ts');
        const body = ipc.slice(
            ipc.indexOf('export function agentRecordAddRuntime'),
            ipc.indexOf('export function agentRecordFront'),
        );
        expect(body).not.toBe('');
        expect(body).toContain('decideTuiSwitch');
        expect(body).toContain('agentAllowedTuis');
        // A refusal must be RETURNED, not swallowed into a success.
        expect(body).toContain("decision.kind === 'refuse'");
        expect(body).toContain('ok: false');
    });

    it('the switcher and the Driver tab both build rows from that one rule', () => {
        // A second copy of "which drivers may this agent take" is how the UI
        // and the host end up disagreeing — the visible symptom being a button
        // whose only outcome is the host's error message.
        const rendererDir = path.join(mainDir, '..', 'renderer');
        const lib = fs.readFileSync(path.join(rendererDir, 'lib/agent-manager.ts'), 'utf8');
        expect(lib).toContain("from '../../main/agents/tui-switch'");
        expect(lib).toContain('export function driverRows');
        for (const component of [
            'components/Master/AgentTuiSwitcher.tsx',
            'components/Master/AgentManager.tsx',
        ]) {
            expect(
                fs.readFileSync(path.join(rendererDir, component), 'utf8'),
                `${component} should build its driver list from driverRows`,
            ).toContain('driverRows');
        }
    });
});

describe('stop is its own verb, everywhere it is offered (genie#474)', () => {
    it('exists as an IPC channel and on the preload bridge', () => {
        expect(read('ipc.ts')).toContain("ipcMain.handle('agents:stop'");
        expect(read('ipc.ts')).toContain('stopRegisteredAgent');
        expect(read('preload.ts')).toContain("ipcRenderer.invoke('agents:stop'");
    });

    it('is reachable from a REMOTE window, like every other agent-record verb', () => {
        // Otherwise `api().agents.stop` falls through to the CLIENT's preload
        // and kills a terminal on the wrong machine while the host's agent keeps
        // running — genie#327's failure mode, one verb later.
        const rendererDir = path.join(mainDir, '..', 'renderer');
        expect(fs.readFileSync(path.join(rendererDir, 'lib/remote-bridge.ts'), 'utf8')).toContain(
            '/api/desktop/agents/stop',
        );
        expect(read('mobile/api.ts')).toContain("op === 'stop'");
    });

    /**
     * The agent SQUARE's menu is the surface the issue narrates: it says the
     * agent is running, it offers Start, and its only two items pointing the
     * other way — Unmount and Delete — remove the agent. Both the right-click
     * menu and the collapsed sidebar's popover run `agentCardMenuItems`, so the
     * item exists once and both must act on it.
     */
    it('is acted on by the agent square’s menu and by the collapsed sidebar', () => {
        const chooser = fs.readFileSync(
            path.join(mainDir, '..', 'renderer/components/Master/Chooser.tsx'),
            'utf8',
        );
        // Two call sites, and they are told apart by the parameter each
        // handler names: the right-click menu dispatches on `id`, the avatar
        // stack's popover on `action`.
        // The window is generous because both branches carry the comment that
        // explains why they are NOT the delete next to them.
        expect(chooser).toMatch(/id === 'stop'[\s\S]{0,1500}?agents\.stop\(/);
        expect(chooser).toMatch(/action === 'stop'[\s\S]{0,1500}?agents\.stop\(/);
        // POSITIVE CONTROL: this file legitimately does open the delete prompt,
        // which is why the absence assertions below are scoped to the two
        // surfaces where Stop is the ONLY removal-adjacent verb offered.
        expect(chooser).toMatch(/openDeletePrompt\(/);
    });

    it('is a menu item only while the agent is RUNNING', () => {
        const menu = fs.readFileSync(
            path.join(mainDir, '..', 'renderer/lib/agent-card-menu.ts'),
            'utf8',
        );
        expect(menu).toMatch(/if \(row\.running\) \{[\s\S]*id: 'stop'/);
    });

    it('never routes through the DELETE path — not in the roster, not in the manager', () => {
        const rendererDir = path.join(mainDir, '..', 'renderer');
        for (const component of [
            'components/Master/WorkspaceSettingsModal.tsx',
            'components/Master/AgentManager.tsx',
            // The imported-project panel (genie#459) mounts the same roster
            // list. Its whole promise is that the AGENT.md files are safe, so a
            // control here reaching the record-removing verb would break it
            // exactly where a person is most anxious about their agents.
            'components/ImportedAgents.tsx',
        ]) {
            const src = fs.readFileSync(path.join(rendererDir, component), 'utf8');
            // POSITIVE CONTROL first: the file really does call stop, so the
            // absence below is about a choice and not about an unrelated file.
            expect(src, `${component} should call agents.stop`).toContain('agents.stop(');
            expect(src, `${component} must never call agents.delete`).not.toContain(
                'agents.delete(',
            );
        }
    });

    it('kills terminals and nothing else — the plan has no record outcome', () => {
        const plan = read('agents/stop-plan.ts');
        expect(plan).toContain('terminalIds');
        // The module is a LEAF by design (the renderer may share it), and a
        // record-touching outcome could only arrive with an import.
        expect(plan).not.toMatch(/^import /m);
        for (const forbidden of ['deleteRegisteredAgent', 'removeFiles', 'agentDir', 'unmount']) {
            expect(plan, `stop-plan must not know about ${forbidden}`).not.toContain(forbidden);
        }
    });
});

describe('the guide no longer describes a control that does not exist', () => {
    /**
     * `guide.ts` told agents to switch "from the driver control in the agent's
     * …" while `AgentManager` had four tabs and none of them was a driver. An
     * agent reading it would tell a user to click something that was not there.
     */
    it('names the surfaces that are actually built', () => {
        const guide = read('mcp/guide.ts');
        expect(guide).toContain('Driver tab');
        expect(guide).toContain('switchTui');
        // And the human's half of `stop`, so an agent asked to hand back does
        // not reach for Delete on the user's behalf.
        expect(guide).toMatch(/\*\*Stop\*\*\s+in the workspace agent roster/);
    });
});
