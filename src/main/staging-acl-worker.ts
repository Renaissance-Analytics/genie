import { isAbsolute } from 'node:path';
import { isMainThread, parentPort, threadId } from 'node:worker_threads';
import { restrictPrivateStagingTargets, windowsHelper } from './private-credentials.js';

if (isMainThread || !parentPort || process.platform !== 'win32') throw new Error('Private staging ACL worker is Windows-only.');
const port = parentPort;
let starts = 0, pid: number | null = null, tail = Promise.resolve(), stopping = false;
const helper = windowsHelper({ onStart: childPid => { starts++; pid = childPid; }, log: () => {} });
const metadata = () => ({ starts, pid, threadId });
port.on('close', () => helper.stop());
port.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || stopping) return;
    const value = message as { kind?: unknown; id?: unknown; mode?: unknown; paths?: unknown };
    if (value.kind === 'staging-acl-stop') {
        stopping = true; void tail.finally(() => { helper.stop(); port.close(); }); return;
    }
    if (value.kind !== 'staging-acl-request' || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0) return;
    const run = async () => {
        let ok = false;
        try {
            if ((value.mode !== 'file' && value.mode !== 'directories') || !Array.isArray(value.paths) || value.paths.length < 1 || value.paths.length > 4 || (value.mode === 'file' && value.paths.length !== 1) || value.paths.some(path => typeof path !== 'string' || !path || path.length > 32768 || !isAbsolute(path))) throw new Error('Refused');
            // An exited child may be observed before its exit event is delivered. Discard only that owned dead child.
            if (pid !== null) { try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') helper.stop(); } }
            await restrictPrivateStagingTargets(value.paths.map(path => ({ path: path as string, directory: value.mode === 'directories' })), helper);
            ok = true;
        } catch { /* No error, path, command, environment or content crosses this private reply. */ }
        try { port.postMessage({ kind: 'staging-acl-result', id: value.id, ok, helper: metadata() }); }
        catch { helper.stop(); port.close(); }
    };
    tail = tail.then(run, run);
});
