import fs from 'fs';
import path from 'path';
import { simpleGit } from 'simple-git';
import { createAgiEnvelope } from '../workspace/create-agi';

export function genieOsWorkspacePath(userDataDir: string): string {
    return path.join(userDataDir, 'genie-os.agi');
}

export async function syncGenieOsWorkspace(userDataDir: string, remoteUrl: string): Promise<string> {
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/i.test(remoteUrl)) {
        throw new Error('Genie OS sync requires a GitHub HTTPS clone URL.');
    }
    const workspacePath = await ensureGenieOsWorkspace(userDataDir);
    const git = simpleGit(workspacePath);
    const remotes = await git.getRemotes(true);
    if (remotes.some((remote) => remote.name === 'origin')) await git.remote(['set-url', 'origin', remoteUrl]);
    else await git.addRemote('origin', remoteUrl);
    const { pushEnvelopeToOrigin } = await import('../workspace/create-agi');
    await pushEnvelopeToOrigin(workspacePath, 'main');
    return workspacePath;
}

/** Ensure the built-in workstation operator has a durable, git-backed memory envelope. */
export async function ensureGenieOsWorkspace(userDataDir: string): Promise<string> {
    const workspacePath = genieOsWorkspacePath(userDataDir);
    if (!fs.existsSync(path.join(workspacePath, 'project.json'))) {
        await createAgiEnvelope({
            slug: 'genie-os',
            name: 'Genie OS',
            parent_path: userDataDir,
            remote: { kind: 'none' },
        });
    }
    fs.mkdirSync(path.join(workspacePath, '.ai', 'memory'), { recursive: true });
    return workspacePath;
}
