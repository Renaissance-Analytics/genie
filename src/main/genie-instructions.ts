import { join } from 'node:path';
import type { GenieInstructionFiles } from './session-host.js';

/** Genie's own words for an agent in an untrusted workspace. Red: the shape only. */
export async function writeGenieInstructions(home: string, _tools: readonly { name: string; description: string }[]): Promise<GenieInstructionFiles> {
    return { promptFile: join(home, 'prompt.md'), pluginDir: join(home, 'plugin') };
}
