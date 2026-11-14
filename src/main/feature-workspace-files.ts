import { lstat, mkdir, readdir as readdirP, readFile as readFileP, rmdir, unlink as unlinkP, writeFile as writeFileP } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AgentFilesHealth, type AgentFilesStep, type SyncSource } from '../core/agent-files-health.js';
import type { WorkTracking } from '../core/genie-protocol.js';
import { writeAgentGitignore } from './agent-gitignore.js';
import { writeAgentRouters } from './agent-routers.js';
import { writeAgentSkills } from './agent-skills.js';
import { writeAgentProtocol } from './config-sync-targets.js';
import type { SettingsStore } from './settings-store.js';

/** The same canonical file writers used by composition, guarded by the host's own trust verdict. */
export function featureWorkspaceFiles(deps: { mayWriteInto(folder: string): Promise<boolean>; settings: Pick<SettingsStore, 'snapshot'>;
    health: AgentFilesHealth; tools(): readonly { name: string; description: string }[]; tracking(): WorkTracking }) {
    const { mayWriteInto, settings, health: agentFiles } = deps;
    return {
        syncAgentDocs: async (workspacePath: string, source: SyncSource = 'start') => {
            if (!(await mayWriteInto(workspacePath))) return;
            const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const on = settings.snapshot().mcp_sync_agents !== false;
            // One node fs for every step; each write and removal is reported to the health record Settings reads.
            const nodeFs = (touched: (path: string) => void) => ({
                read: async (p: string) => { try { return await readFileP(p, 'utf8'); } catch { return null; } },
                write: async (p: string, text: string) => { await mkdir(dirname(p), { recursive: true }); await writeFileP(p, text, 'utf8'); touched(p); },
                remove: async (p: string) => { try { await unlinkP(p); touched(p); } catch { /* not there: nothing to remove */ } },
                unlink: async (p: string) => { await unlinkP(p); touched(p); },
                list: async (d: string) => { try { return await readdirP(d); } catch { return []; } },
                removeDir: async (d: string) => { try { await rmdir(d); } catch { /* not empty or not there: left as it is */ } },
                isSymlink: async (p: string) => { try { return (await lstat(p)).isSymbolicLink(); } catch { return false; } },
                exists: async (p: string) => { try { await lstat(p); return true; } catch { return false; } },
            });
            const steps: AgentFilesStep[] = [
                // First, whatever the switches: the files that carry Genie's MCP token are kept out of a commit.
                { step: 'gitignore', run: (t) => writeAgentGitignore({ workspacePath, fs: nodeFs(t) }) },
                // The protocol files (.agents/_genie/), true for Genie 2, listing the tools Genie's MCP actually serves.
                { step: 'protocol', run: (t) => writeAgentProtocol({ workspacePath, enabled: on, tools: deps.tools(), tracking: deps.tracking(), fs: nodeFs(t) }) },
            ];
            if (on) {
                // The routers and RULES.md after the protocol they import (Genie 1's repaired); then Genie 2's skills.
                steps.push({ step: 'routers', run: (t) => writeAgentRouters({ workspacePath, stamp, fs: nodeFs(t) }) });
                steps.push({ step: 'skills', run: (t) => writeAgentSkills({ workspacePath, stamp, fs: nodeFs(t) }) });
            }
            // A failing step is recorded and does not stop the steps after it.
            const report = await agentFiles.run(workspacePath, steps, Date.now(), source);
            for (const f of report.failed) console.error(`[workspace-files] ${workspacePath} ${f.step}: ${f.error}`);
        }
    };
}
