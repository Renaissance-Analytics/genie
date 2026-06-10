# `.agi` envelope format

The `.agi` envelope is a git-based workspace format that wraps one or
more source repositories alongside a shared `.ai/` knowledge zone. The
format is read and written by both Genie (this client) and the Aionima
AGI gateway; both tools preserve unknown fields on write so neither
clobbers the other's state.

## Folder skeleton

```
<slug>.agi/
├── project.json           ← shared config (Genie + AGI gateway)
├── .gitmodules            ← submodule registry
├── repos/                 ← each subfolder is a git submodule
│   ├── <repo-1>/
│   └── <repo-2>/
├── .ai/                   ← shared knowledge zone (tracked in envelope)
│   ├── plans/
│   ├── knowledge/
│   ├── pm/
│   ├── chat/
│   ├── memory/
│   └── issues/
├── sandbox/               ← scratch space (gitignored)
└── .trash/                ← soft-delete buffer (gitignored)
```

## Properties

- The envelope itself is a git repository. Its conventional remote name
  uses the `.agi` suffix so anyone looking at a remote list can tell at
  a glance that this is an envelope, not a project repo.
- Each `repos/<name>/` is a git submodule. Submodules pin to commits
  (standard git behaviour); the envelope user advances them manually.
- `.ai/`, `sandbox/`, `.trash/` are tracked directly in the envelope and
  are never themselves submoduled. `sandbox/` and `.trash/` are
  gitignored by the standard envelope template.
- `project.json` is the shared config Genie and the AGI gateway both
  read and write. Both tools preserve unknown fields when patching, so
  Genie-only and gateway-only keys coexist safely.

## Compatibility with legacy `k/`

Earlier versions of the format used `k/` instead of `.ai/` for the
shared knowledge zone. New envelopes always use `.ai/`. When importing
or converting an existing folder via Genie's Interactive Upgrade
wizard, a top-level `k/` directory is recognised as a knowledge root
and its contents are spread directly into the new envelope's `.ai/`.

## Detection (when Genie opens a folder)

Genie classifies an arbitrary folder as one of:

- **EMPTY** — no `.git`, no significant contents. Eligible for a
  fresh envelope scaffold.
- **SIMPLE_REPO** — has its own `.git/` but no `repos/` and no
  `project.json`. Eligible for the Convert wizard (becomes a submodule
  inside a new envelope).
- **PRE_INIT** — has `repos/<name>/.git` but no root `.git` and no
  `.gitmodules`. Eligible for re-initialisation into a proper envelope.
- **FULL_ENVELOPE** — has `.git`, `.gitmodules`, `repos/`, and
  `project.json`. Eligible for opening directly.

## See also

- `main/workspace/create-agi.ts` — envelope scaffold + submodule add
  primitives.
- `main/workspace/analyse.ts` — the Interactive Upgrade wizard's
  classification heuristics (repos / knowledge / other).
- `main/workspace/project-json.ts` — read + atomic-write with
  preserve-unknown-fields semantics.
