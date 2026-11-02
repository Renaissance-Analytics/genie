import { closeInheritedFds } from './inherited-fds.js';

/**
 * Side effect, on import: close the sockets and pipes this process inherited from its parent (main/inherited-fds.ts).
 * genie-host.ts and spawn-host.ts import it FIRST, so it runs before any module of theirs can open anything — and
 * nothing they start later (spawn hosts, pty helpers, shells, providers) can inherit what the window held.
 */
const closed = closeInheritedFds();
if (closed.length > 0) console.log(`[genie] closed ${closed.length} socket/pipe fd(s) inherited from the parent process (pid ${process.ppid}): ${closed.join(', ')}`);
