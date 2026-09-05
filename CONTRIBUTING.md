# Contributing

Genie is an Electron + Next.js desktop app. This document is the working manual for
changing it — read the section that applies to you, then the shared rules at the bottom.
**Everyone follows the shared rules.**

- [For humans](#for-humans)
- [For agents](#for-agents)
- [Shared rules](#shared-rules-everyone) — engineering standards, tests, shipping

---

## For humans

### Dev loop

```bash
git clone git@github.com:Renaissance-Analytics/genie.git
cd genie
npm install
npm run dev        # nextron launches Electron + Next.js dev server
```

Other scripts you'll want:

```bash
npm run typecheck:main      # tsc --noEmit on main/
npm run typecheck:renderer  # tsc --noEmit on renderer/
npm run test                # vitest — main-process + renderer unit tests
npm run test:watch
npm run test:e2e            # Playwright + Electron. See the warning below.
```

Genie talks to **Tynn** over HTTP, defaulting to `https://tynn.ai`. For local Tynn work,
set `Tynn host` in Settings to `https://tynn.test` (or wherever your Herd instance lives).

### Where to align before building

Open an issue and agree the approach **before** opening a PR for:

- Anything changing the on-disk format of `.agi` envelopes or `project.json`. The format is
  shared across the Aionima ecosystem — it can't change unilaterally.
- Schema migrations in `main/db.ts`. The migration runner is append-only by design and
  unforgiving; a migration that ships wrong is very hard to walk back off users' machines.
- The multi-attach pty manager. The invariants are subtle — refcounting owners across
  windows, scrollback bounding, detach-vs-kill semantics.
- Token storage, Device Flow, or `safeStorage`. Security-sensitive; it wants a second pair
  of eyes on the diff.
- Access-control surfaces (AgentInbox scopes, workspace `agent_access`, approval gates).
  Widening one by accident is silent until it isn't.

### PR expectations

Open against `main`, squash on merge. Conventional prefixes (`feat:`, `fix:`, `docs:`,
`chore:`) are appreciated. For anything visible in the UI, put a screenshot or short
recording in the description — it's the fastest review you'll ever get.

---

## For agents

Everything in [For humans](#for-humans) applies to you too. These are the additional
requirements.

### Model requirement

Agent contributions must be made with a **current flagship model at its highest reasoning
setting**:

- **Claude — Opus 4.8**, high reasoning effort.
- **Codex** — the equivalent current flagship, at its highest reasoning setting.

Do not contribute from a smaller or older model. The work in this repo is dense with
invariants that cheaper models reliably miss — pty refcounting, migration ordering,
two-tier access predicates. A plausible-looking diff that violates one of those costs far
more to find later than it saved up front.

If you are a subagent spawned for a mechanical subtask, you inherit this requirement.

### You are probably not being watched

Genie hosts many terminals across many projects at once. If you are running inside one,
assume nobody is reading your output. Printing "done" or asking a question in plain text
stalls the work indefinitely.

- **Finished or handing back** → call `imDone`. Every time.
- **Need a decision** → call `ForceTheQuestion`. Never ask in plain text and wait.

Pass your `GENIE_TERMINAL_ID` so it targets the right terminal.

### Report what actually happened

State results plainly. If tests fail, say so and show the output. If you skipped a step,
say which. If something is unverified, say it is unverified — a green unit suite is not
evidence that a UI renders, and "typechecks" is not "works".

Do not describe work as complete when part of it is untested, and do not let a passing
CI run stand in for verification it never performed.

### Read before you write

Before changing a repo: read its docs, inspect the current branch and recent release
history, and identify the actual path from implementation to release. Do not infer one
repo's workflow from another's — they differ deliberately.

---

## Never report a success you have not verified

**Say what you established, not what you hoped.** This is one anti-pattern that has
produced at least six separate bugs, and it keeps recurring because each instance
looks locally reasonable.

The shape is always the same: something reports **worked** / **ready** / **done** at
a moment when nothing has established that it is true.

- `restartAgentTerminal` returned `{ok: true}` once it had spawned a pty. The agent
  died a second later; the user had been told "agent restarted" (#364).
- A site's `ready` flag was written on the start path and read forever after, so
  `ready: true` outlived the backend it measured (#305).
- `manageSite restart` on a host site recycles Genie's proxy, not the dev server
  behind it, and reports success — its own comment admits it (#226).
- `artboard post`'s tool description promised it "opens and focuses the panel".
  Nothing did (#306).
- "may still be starting" named no port and no check, so nobody could falsify it
  (#227).

**Why it is worse than an ordinary bug:** an AGENT cannot look at the screen and
notice the claim was false. It takes `ok: true` literally, reports done to the
person, and moves on. A false success does not just fail — it *propagates*, and the
person finds out much later and much further from the cause.

### The rule

When you are about to report a result, one of three things must be true:

1. **You verified it.** The check was available, and you ran it.
2. **You narrowed the claim to what you actually know.** `submitted`, `accepted`,
   `requested`, `queued` — not `done`. A caller can act correctly on "submitted";
   nobody can act correctly on a false "done".
3. **You said it is unverified, and what would settle it.** An honest
   "I could not confirm this — check X" is far more useful than a confident wrong
   answer.

A hedge that cannot be checked (*"should be ready shortly"*) is not option 3. It is
option 1 with the evidence removed.

This applies to code and to prose equally. A tool DESCRIPTION in `protocol.ts` is
read by an agent as a promise about behaviour; if the code does not do what the
description says, the description is a bug of exactly this kind.

### Four ways a check quietly answers a weaker question

All four have shipped here. All four looked like guards and none was one.

**A SQLite `CHECK` whose expression can evaluate to NULL passes.** NULL is not
FALSE. So this constraint, written to make a denormalisation impossible to get
wrong, does not:

```sql
CHECK (origin_ns IS NULL OR origin_key LIKE origin_ns || '/%')
```

```
ACCEPTED : ns="pack1" key="pack1/node"     -- correct
REJECTED : ns="pack1" key="other/node"     -- catches a WRONG key
ACCEPTED : ns="pack1" key=NULL             -- misses a MISSING one
```

It catches a wrong value and misses an absent one — the exact case it existed to
prevent. The general shape: `a IS NULL OR b <op> ...` is unguarded whenever `b`
is NULL. Spell out the `IS NOT NULL`.

**`toContain` over a large document is a coincidence detector, not a check.** A
guide-sync test asserting the 43KB agent guide contains `unresolved`, `ambiguous`
and `all` passed before any of that feature existed — the words occur in an
unrelated IssueWatch section, inside *"unambiguous"*, and somewhere in 43KB. A
green test standing where the check should be is worse than no test.

**A test whose FIXTURE cannot reach the branch is indistinguishable from one that
proves the fix.** The first two weaken the ASSERTION. This one never runs the
code at all, and it is harder to see, because the test is correct — about a
configuration that cannot exhibit the bug.

`manageSite stop` reported `external: false` for a site that set BOTH
`runMode: host` and `hostPort`, so it dropped the note saying the user's own dev
server is still running (#226). The test written to cover exactly that case used
`runMode: 'explicit'`, which never reaches the disputed branch. The residual
outlived two passes aimed straight at it — and one of those passes checked its
own fix and found it working, because the sibling code path READ THE CONFIG
rather than the report and was right about a site `stop` was wrong about.

Same shape in a source-scanning guard: `provider-literal-guard` stripped comments
with a `/*…*/` SPAN regex, so a `/*` inside a string literal opened a span nobody
wrote and deleted every line up to the next `*/` from the scan. It read
`main/ipc.ts`, reported it CLEAN, and line 1785 held the very union it was
hunting (#404). Strip comments line-based; a span cannot tell a comment from a
string.

**A test that asserts what the code RETURNS rather than what the requirement
SAYS.** The first three weaken the assertion or never reach the branch. This one
is precise, calls the right function, and is simply about the wrong thing: it
records the implementation's current answer as though that answer were the
specification. Nothing about it looks wrong, and it will keep passing forever
while the requirement is violated.

`HostToolSpec.probe: false` exists so a row can decline to claim anything about
the machine — Amazon Q's binary is `q`, too generic to look for without reporting
some unrelated program as an installed coding agent. The unit test asserted
`tone === 'not-installed'` and passed, because that is what `toolUpdateTone`
returned — not because it is what the row must say. The badge renders straight
off the tone, so the row went on printing:

```
Amazon Q Developer CLI  [Not installed]  …its binary `q` is too generic for
Genie to detect safely — so this row says what it is and makes no claim about
whether you have it.
```

A row stating the claim its own copy denies making, under a green test.

Two things generalise past this row:

**`installed` is undefined for BOTH "we looked and it is absent" and "we never
looked".** A field that conflates two states will be read as the more common one
by every consumer written before the second state existed — `toolUpdateTone`
reached `if (!u.installed) return 'not-installed'` and never got as far as asking.
Adding a state to a system usually means adding a FIELD, not a new reading of an
existing one.

**A unit test only checks the fields you thought of, and the bug was in a field
nobody thought of.** The E2E caught this because it reads the whole rendered row
rather than one field. Not "E2E is better" — a whole-output assertion catches the
field you did not think to name.

Note the sibling found in the same PR, which looks nothing like it:
`HOST_SOURCED_SETTINGS_KEYS` exists twice, and the two copies disagreed for
months while both sides' tests passed — each asserting against its own
hand-written copy of the list. That compares a list to itself; this compares a
function to its own output. **Both are the implementation grading its own
homework.** Two instances that share no surface features is what makes the
pattern worth naming rather than the instance.

The replacement test is better in one further way: it asserts the POSITIVE state
("Not checked") as well as the absence, so a regression cannot satisfy it by
rendering nothing at all. **A negative assertion needs a positive control, or a
corpse passes it.**

All four are the same fault as the bugs this codebase keeps finding in its
product: a lookup that always finds *something* and never reports that it was the
wrong something. When you write a guard, make it fail first — and make it fail
for the reason you think it will. Then check the other half: that your FIXTURE
reaches the code you are guarding, and that the value you assert is the one the
REQUIREMENT names rather than the one the function happens to return today. A
green that measured less than it appeared to is the failure this repository keeps
meeting in new clothes.

### And one no per-PR check can see at all

The four above are checks that measured less than they appeared to. This one is
different in kind: **there is no check to weaken, because the thing that breaks
exists in neither branch.**

> Two PRs each green against `main` and never rebased onto each other still never
> run the array containing both — only a merge queue or a rebase-before-merge
> rule catches that.

Both greens are honest. Each PR's CI ran a tree that contained its own change and
not the other's, and the tree that contains both is first assembled by the merge
itself, after every check has passed. There is no merge queue here, so nothing
ever builds that tree before it is `main`.

It happened twice in three hours:

- **#427 and #428** — #428 was rebased before #427 merged, so neither one's CI
  ever saw the other's change. Two true greens, one red `main`. Fixed in #430.
- **#422 and #428** — both added a migration numbered **71**. Git merges that
  cleanly; they are separate elements of the same array. `schema_version.version`
  is an `INTEGER PRIMARY KEY` and the applier's transaction has no catch, so the
  second entry's INSERT would have thrown out of `initDatabase` and **Genie would
  not have booted for anyone.** Caught by hand during a rebase, and fixed in #422.

`main/__tests__/db-migrations.test.ts` now guards the migration case
specifically: it scans the declared version numbers and names any that repeat,
and applies them all against a real in-memory database. **That converts the
migration instance from "silent until somebody upgrades" into "loud on the next
rebase" — it does not close the class.** Nothing in a per-PR check can, and no
test elsewhere makes the general case visible either.

What actually helps, until there is a merge queue: rebase onto `origin/main` and
re-run CI **immediately before** merging, and report the head SHA alongside the
conclusion. A conclusion without the SHA it belongs to is how a stale green gets
read as a current one.

---

## Known constraints — decided, not discovered

Things that are deliberately not-yet. **These are settled.** Do not re-diagnose them,
do not file issues about them, and do not present them as findings — note the
constraint, work around it, move on.

### macOS builds are UNSIGNED, and that is expected for now

`MAC_CSC_LINK` is not set and the signing secrets do not exist. Every release log
says so:

```
⚠️ macOS signing: unsigned — MAC_CSC_LINK is not set
```

Signing is a business step (an Apple Developer account and a notarisation identity),
not an engineering gap, and we are not ready for it yet.

**What that means when you are reasoning about a Mac bug:**

- **Hardened Runtime is not in effect**, so `build/entitlements.mac.plist` does
  nothing on any build shipped to date. Any explanation that depends on macOS
  enforcing entitlements is wrong for the artifact users actually run.
- The working mechanism for the shipped build is the **ad-hoc signature** applied
  after packaging — look for `[after-pack] fancy-term-host node-pty: darwin ->
  fixed (ok=true) - ad-hoc signed spawn-helper` in the release log. That is what
  keeps Apple Silicon from SIGKILLing an unsigned `spawn-helper`.
- Gatekeeper warnings, quarantine prompts and updater signature failures on macOS
  are **expected consequences**, not bugs to chase.

So: reason from the ad-hoc path, not the entitlements path. If a fix genuinely
requires signing, say "this needs signing, which is not available yet" and stop
there.

---

## Shared rules (everyone)

### TDD — write the failing test first

**Write the test. Run it. Confirm it fails for the right reason. Then implement.**

1. Write or update a test expressing the required behaviour; run it and watch it fail.
2. Implement the smallest root-cause fix that makes it pass.
3. Refactor without changing behaviour, keeping tests green.
4. Run the focused **and** release-facing validation layers.

A test written after the implementation tends to encode whatever the code already does,
bugs included, and can pass for the wrong reason. The red→green transition is the only
real evidence a test exercises what it claims to.

When a test genuinely must be written after the fact — a pre-existing feature, or a UI
path already shipped — passing is not enough. **Prove it isn't vacuous:** break the
behaviour or the selector, confirm it goes red, restore it, and say so in the PR.

Changing intended behaviour means updating existing tests — rewrite them to assert the new
contract precisely. **Never loosen an assertion to get green.**

### No bandaids

Fix the root cause. Never paper over a symptom.

Don't mask a vulnerable transitive dependency with an overrides pin when the real fix is
updating the dependency that pulls it. Don't swallow an error, hardcode around a bug, or
weaken a test to make something pass. A bandaid is a hidden bug — it will resurface, later
and more expensively.

### Tests

Vitest covers main-process logic, renderer units, and filesystem integration. Run it
locally; it's fast.

**Electron E2E lives in `e2e/` (Playwright + the `_electron` API) and runs on CI VMs
only — never locally.** A local run steals window focus and fights the Genie instance you
already have open. CI runs it in a clean VM per OS with no live Genie, which is exactly
what catches boot-time regressions that a compile-only check sails past.

Practical consequence: for E2E, the "watch it fail" step of TDD happens on CI. Push the
failing test first when you can.

E2E specs drive the real compiled app. Harness pages under `renderer/pages/e2e-*.tsx` mount
a real component in isolation; fixtures live in `main/e2e/`. Prefer driving the **real**
IPC and database over mocks when the thing under test *is* the persistence chain — a mock
proves the mock works.

Note: `e2e/` is currently outside both tsconfigs, so specs are not typechecked by any
script. Check them by hand until that's fixed.

### Shipping — implementation approval is not release approval

"Fix it", "build it", "commit it", or "open a PR" does **not** authorize merging, tagging,
publishing installers, deploying, or advancing the auto-update feed.

`release.yml` is **tag-triggered**. Pushing a branch or landing on `main` publishes nothing
on its own — but do not treat that as licence to skip the gate. Before any release action,
present the exact commits, the test evidence, the target channel, and the proposed version,
then get explicit approval for **that** release.

Never create or push a `v*` tag without it.
