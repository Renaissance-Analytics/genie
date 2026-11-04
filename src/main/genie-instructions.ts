import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { providerProtocol, sharedProtocol } from '../core/genie-protocol.js';
import { GENIE_SKILLS, skillFile } from './agent-skills.js';
import type { GenieInstructionFiles } from './session-host.js';

/**
 * GENIE'S OWN WORDS, FOR AN AGENT IN A WORKSPACE THE PERSON HAS NOT TRUSTED. Project settings are off for that agent, which also leaves out a folder's CLAUDE.md and skills, Genie's among them. So they reach it from here, under Genie's own data: a
 * prompt file (a file, because 200 KB inline fails with E2BIG even on Linux, and Windows' command line is far shorter) and a plugin folder. Nothing is read from the workspace. Each file is replaced whole, as agents starting together share them and one may be reading.
 */
const NOTE = `## This workspace is not trusted yet

The person has not said yes to what this folder's own files would run. So its instructions, skills, hooks and MCP servers are not loaded, and every shell command asks first. You can't see this project's rules. If you need them, say so: only the person can trust the workspace.`;

let written = 0;

export async function writeGenieInstructions(home: string, tools: readonly { name: string; description: string }[]): Promise<GenieInstructionFiles> {
    const promptFile = join(home, 'prompt.md');
    const pluginDir = join(home, 'plugin');
    const put = async (path: string, text: string) => {
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}.${++written}.tmp`;
        await writeFile(temporary, text, 'utf8');
        await rename(temporary, path);
    };
    const promptText = [sharedProtocol(tools), providerProtocol('claude'), NOTE].join('\n\n');
    await put(promptFile, promptText);
    await put(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'genie-own', version: '1.0.0', description: "Genie's own skills" }, null, 2));
    for (const skill of GENIE_SKILLS) await put(join(pluginDir, 'skills', skill.name, 'SKILL.md'), skillFile(skill));
    return { promptFile, pluginDir, promptText };
}

/** Skeleton. */
export async function codexFolderSkills(_cwd: string): Promise<string[]> {
    return ['skeleton'];
}
