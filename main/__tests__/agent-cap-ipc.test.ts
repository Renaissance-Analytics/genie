import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * WHO may change the agent-terminal cap (Tynn #117).
 *
 * The cap is only a cap because an agent cannot raise it, and that is enforced
 * structurally rather than by a runtime check: the setter is reachable from ONE
 * IPC channel, which only a real window's preload can call. `main/mcp/` — every
 * agent-facing tool — must never name that channel or the setter.
 *
 * Source-text assertions rather than behavioural ones because the thing being
 * pinned IS the absence of a call site. A behavioural test can only exercise call
 * sites that exist; this catches the one somebody adds.
 */
const mainDir = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(mainDir, rel), 'utf8');

const CHANNEL = 'workspaces:set-max-agent-terminals';

describe('the agent-terminal cap is written from a window, and only a window', () => {
    it('is handled in main/ipc.ts, which is where a window can reach it', () => {
        // Positive control for the absence assertions below: they are about a
        // channel that genuinely exists and genuinely writes the cap, not about a
        // string nobody has implemented yet.
        const ipc = read('ipc.ts');
        expect(ipc).toContain(`'${CHANNEL}'`);
        expect(ipc).toContain('setWorkspaceAgentCap');
    });

    it('is exposed on the preload bridge so the settings UI can call it', () => {
        expect(read('preload.ts')).toContain(CHANNEL);
    });

    it('is named nowhere under main/mcp/ — no agent-facing tool can invoke it', () => {
        const mcpDir = path.join(mainDir, 'mcp');
        const files = fs.readdirSync(mcpDir).filter((f) => f.endsWith('.ts'));
        // Positive control: the directory really was read and really does contain
        // the agent-facing tool surface, so an empty offender list means something.
        expect(files).toContain('host-tools.ts');

        const offenders = files.filter((f) => {
            const src = fs.readFileSync(path.join(mcpDir, f), 'utf8');
            return src.includes(CHANNEL) || src.includes('setWorkspaceAgentCap');
        });
        expect(offenders).toEqual([]);
    });
});
