import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptDirFor } from '../../agentinbox/session-capture';

/**
 * A CONVERSATION THAT ACTUALLY EXISTS — for tests whose subject is a restart.
 *
 * Genie's restart decisions are made against the transcripts Claude writes under
 * `~/.claude/projects/<encoded cwd>/<session id>.jsonl`. A fixture that sets
 * `meta.chat_session_id` and stops there is describing a conversation nobody can
 * find: the id resolves to no file, the cwd holds no chat, and the honest answer
 * to "resume it" is that there is nothing to resume.
 *
 * That used to be invisible. The drift fallback rendered `claude --continue`
 * whenever the exact id could not be verified, so a fixture with a phantom id
 * produced a plausible-looking command and the tests went green. On a real
 * machine the same command answers **"No conversation found to continue"** and
 * exits, leaving a bare shell where the agent should be — which is what the
 * owner hit. The command is now chosen by asking whether the cwd holds any chat
 * at all, so a fixture has to mean what it says.
 *
 * ## Why a temp HOME rather than the real one
 *
 * The encoded directory is derived from the cwd, and these suites use `mkdtemp`
 * cwds — so writing a transcript for one would leave a junk project directory in
 * the developer's own `~/.claude/projects` on every run. Tests do not get to
 * litter the machine they run on. `os.homedir()` reads `USERPROFILE` on Windows
 * and `HOME` elsewhere, so redirecting both keeps every write inside the
 * suite's own scratch space.
 */

/**
 * Redirect `os.homedir()` to a scratch directory for this test PROCESS and
 * return it. Call at module scope, before anything resolves a transcript path.
 */
export function useTempClaudeHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-claude-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    return home;
}

/**
 * Write a transcript for `sessionId` in `cwd`'s project dir, so both questions a
 * restart asks — "does THIS id have a transcript" and "does this folder hold any
 * chat" — answer yes. Returns the file path.
 */
export function writeTranscript(cwd: string, sessionId: string): string {
    const dir = transcriptDirFor(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: 'hello' })}\n`);
    return file;
}
