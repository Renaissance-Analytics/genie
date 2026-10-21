import { GENIE_FALLBACK_IDENTITY } from './github.js';

/**
 * ADDING A WORKSPACE THE WAY GENIE 1 DID (the owner, 2026-10-21: "Look at Genie 1"; Genie 1's add-workspace.ts and
 * workspace-onboarding.ts). The pure half: the folder a new workspace gets, why one cannot be made, and where a folder
 * picker opens.
 */

/**
 * Genie 1's `workspaceFolderName` (workspace-onboarding.ts): lowercase; letters, digits and dots kept; runs of anything
 * else to one dash; dots and dashes trimmed from the ends; then `.agi` — unless the name already ends in it, so "foo.agi"
 * stays "foo.agi" and never becomes "foo-agi.agi". Empty = no folder can be made. (Genie 1 also left `.gapp` alone;
 * GApps are not part of Genie 2.)
 */
export function workspaceFolderName(name: string): string {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
    if (slug === '') return '';
    return slug.endsWith('.agi') ? slug : `${slug}.agi`;
}

/** Genie 1's refusals (add-workspace.ts `addWorkspacePlan`), in its words; `null` = a workspace can be made. */
export function newWorkspaceProblem(name: string, parent: string): string | null {
    if (name.trim() === '') return 'Give the workspace a name.';
    if (parent.trim() === '') return 'Choose where the workspace should live.';
    if (workspaceFolderName(name) === '') return 'Give the workspace a name it can be a folder for.';
    return null;
}

/**
 * WHAT A NEW WORKSPACE'S FIRST COMMIT HOLDS. The Add workspace card promises "Genie makes the folder and its first
 * commit"; this is Genie 1's createAgiEnvelope scaffold (create-agi.ts), its words, with one change: Genie 1's agent guide
 * was AGENTS.md with CLAUDE.md a symlink to it, and Genie 2 keeps a workspace's instructions in RULES.md with AGENTS.md and
 * CLAUDE.md as its routers to them (main/agent-routers.ts) — so the guide is RULES.md here, and the first sync finds the
 * commit already in its shape instead of rewriting four files of a repository a minute old.
 */

/** Genie 1's skeleton. Each gets a `.gitkeep` so git keeps the empty folder. */
export const ENVELOPE_DIRS: readonly string[] = ['repos', '.ai', '.ai/plans', '.ai/knowledge', '.ai/pm', '.ai/chat', '.ai/memory', '.ai/issues', 'sandbox', '.trash'];

/** Genie 1's .gitignore: sandbox/ and .trash/ never committed, their `.gitkeep` kept so the folders survive a clone. */
export const ENVELOPE_GITIGNORE = `# Envelope-owned scratch, never committed.
sandbox/**
!sandbox/.gitkeep

# Soft-delete buffer.
.trash/**
!.trash/.gitkeep

# Local OS noise.
.DS_Store
Thumbs.db
*.log
`;

/** Genie 1's subject — with the folder in it, where Genie 1 wrote a literal `{slug}`. */
export const firstCommitMessage = (folder: string): string => `Initial commit — ${folder} envelope scaffolded by Genie`;

/** Genie 1's README for people. Its last line said CLAUDE.md is a symlink to AGENTS.md; in Genie 2 neither is. */
export function envelopeReadme(name: string, folder: string): string {
    return `# ${name}

This is a **\`.agi\` envelope** — a project monorepo that bundles
one or more code repositories together with shared knowledge, planning,
and scratch space. Created with Genie.

## Layout

\`\`\`
${folder}/
├── project.json     Envelope manifest — repo registry + metadata
├── .gitmodules      Submodule registry (the repos below)
├── repos/           Code repositories, each a git submodule
├── .ai/             Shared knowledge (humans + agents)
│   ├── knowledge/   Notes, docs, references
│   ├── plans/       Plans and design docs
│   ├── pm/          Project management
│   ├── chat/        Saved conversations
│   ├── memory/      Long-lived agent memory
│   └── issues/      Issue notes
├── sandbox/         Scratch space (gitignored)
└── .trash/          Soft-delete buffer (gitignored)
\`\`\`

## Working with it

Clone with submodules:

\`\`\`
git clone --recurse-submodules <url>
# or, after a plain clone:
git submodule update --init --recursive
\`\`\`

Each folder under \`repos/\` is an independent repository pinned to a
specific commit. The envelope tracks \`project.json\`, \`.ai/\`, and the
submodule pointers — never the code inside the submodules (that lives in
each repo). Advance a pin with \`git submodule update --remote repos/<name>\`.

For the agent-oriented version of this guide, see \`RULES.md\`
(\`AGENTS.md\` and \`CLAUDE.md\` load it for agents).
`;
}

/** Genie 1's agent guide (its AGENTS.md), as the workspace's RULES.md — where Genie 2's routers send every agent. */
export function envelopeRules(name: string): string {
    return `# Workspace rules

## ${name} (.agi envelope)

You are working inside a **\`.agi\` envelope**: a project monorepo.

## Structure

- \`repos/<name>/\` — code repositories, each a git **submodule** pinned to
  a commit. Do code work INSIDE these: commit/push in the repo, then the
  envelope's submodule pointer is advanced separately.
- \`.ai/\` — shared knowledge, writable by humans and agents:
  - \`.ai/knowledge/\` — notes, docs, references
  - \`.ai/plans/\` — plans and design docs
  - \`.ai/pm/\` — project management
  - \`.ai/chat/\` — saved conversations
  - \`.ai/memory/\` — long-lived memory
  - \`.ai/issues/\` — issue notes
- \`sandbox/\` — scratch space, gitignored. Use freely; never relied upon.
- \`.trash/\` — soft-delete buffer, gitignored.
- \`project.json\` — the envelope manifest (repo registry + metadata).

## Rules

- The envelope never commits code that belongs to a submodule. Code lives
  in \`repos/<name>\`; the envelope only tracks the submodule pointer.
- \`.ai/\`, \`sandbox/\`, \`.trash/\` are envelope-owned — never submoduled.
- After cloning: \`git submodule update --init --recursive\`.
- Submodule pins advance deliberately
  (\`git submodule update --remote repos/<name>\`), not automatically.
`;
}

/**
 * The identity config a Genie-made commit needs, given what git already has (Genie 1's `identityToApply`, genie#215):
 * only the MISSING fields, filled with Genie's bot, so a configured person keeps their own and a half identity is
 * completed, not replaced. A blank value is missing — git fails a commit on `user.email ""` as on none. The caller
 * passes these as `-c` for that one command; nothing is written to anyone's git config.
 */
export function commitIdentityConfig(have: { name: string | null; email: string | null }): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    if (!have.name?.trim()) out.push(['user.name', GENIE_FALLBACK_IDENTITY.name]);
    if (!have.email?.trim()) out.push(['user.email', GENIE_FALLBACK_IDENTITY.email]);
    return out;
}

/**
 * WHERE A FOLDER PICKER OPENS (the owner, 2026-10-21): in the scope of a workspace, that workspace's folder; from the
 * workstation, the Primary workspace (Settings → General); else the home folder; the bare root (`/`, the drives on
 * Windows) only when nothing better is known.
 */
export function pickerStart(at: { workspacePath?: string | null | undefined; primaryWorkspace?: string | null | undefined; home?: string | null | undefined }): string {
    for (const p of [at.workspacePath, at.primaryWorkspace, at.home]) if (typeof p === 'string' && p.trim() !== '') return p.trim();
    return '/';
}
