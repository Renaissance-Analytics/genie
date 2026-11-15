# Provider account book (Accounts S1)

`genie-host` opens `AccountsHost` before its session host accepts work. The book is
`<GENIE_HOME>/runtime/accounts.json` (`version: 1`, `accounts: AccountRecord[]`).
The existing atomic/durable JSON writer persists each mutation before the new
view is published. Mutations on this single host owner are serialized; callers
await them. An invalid or unreadable book refuses startup, rather than replacing
the person's account records with an empty book.

`src/core/accounts.ts` defines `AccountRecord`: `id`, `provider` (`claude` or
`codex`), `label`, `labelEdited`, absolute `home`, `legacy`, `identity`
(`name`, `email`, `plan`, each `string | null`), and ISO `createdAt`.

`AccountsHost.open({root, legacyHomes, now?, mintId?, provision?})` returns the
one host owner. `list()`, `get(id)` and `defaultFor(provider)` return detached
views. `add({provider, label?})`, `rename(id, label)` and
`recordIdentity(id, {name,email,plan})` are asynchronous durable mutations.
`get`/`defaultFor` return null for an unknown account/provider; mutations refuse
unknown ids or malformed fields. `provision` is a trusted host composition port,
not a renderer or workspace callback.

The default ids are `account_legacy_claude` and `account_legacy_codex`. First boot
records the host's existing `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, falling back to
the OS profile's `.claude` / `.codex`. No provider home is opened or moved, and
later changes to the ambient environment do not rewrite those references.
Managed ids are `account_<32 lowercase hex digits>`; new homes are exclusively
reserved at `<root>/accounts/<provider>/<id>`. Existing directories and links
are refused. Provisioning failure never publishes an account or deletes files
the provider might have created there.

New homes receive native instructions and skills generated from Genie's
canonical protocol/skill owners, an independently generated Genie plugin,
Claude's initially empty settings or Codex's explicit file-store setting. No
existing provider settings, plugins, history or credentials are copied. MCP
servers and caller authority are supplied per launch by SessionHost, never
persisted as a shared account token. Session launch binding belongs to S3.

Identity starts as three nulls. `recordIdentity` performs no provider calls or
credential I/O; S4 supplies only metadata reported by the provider's own status
command. An untouched fallback label (`Account 1`, `Account 2`, ...) adopts a
reported email. A person's explicit add/rename label is preserved. A missing
field stays null; Genie never guesses a plan or derives identity from a token.

S1 introduces no UI, login, account switch or agent reassignment. Real account
isolation remains unmeasured until the owner-arranged VM sign-ins.

## Agent bindings and native threads (Accounts S2)

New and loaded `AgentRecord`s have an explicit `accountId`. Older records bind
to their provider's stable legacy account; their current `threadId` and other
settings stay unchanged. The store persists that migration before exposing its
first read/write. Invalid bindings are reported through the existing dropped
record diagnostics rather than assigned to a different account.

`threadIds` and `leftAt` use `accountThreadKey(provider, accountId)` from the
pure model (`provider:accountId`). Old provider-only entries become entries for
that provider's legacy account, including on an already-bound managed record.
An entry already in the new format takes precedence over an older duplicate.

`Registry` accepts a trusted optional `accountById` port; genie-host supplies its
account book. Its internal `setProvider` primitive accepts an optional explicit
`accountId`. A managed assignment requires a matching account in that book.
Without an explicit account, keeping a provider keeps its current binding;
changing provider selects the destination's legacy default. Leaving parks the
native thread under its exact namespace; returning resumes only that slot.
Provider-switch carry-over uses that destination account's departure time.

These are data/model primitives. No account-switch tool, UI action or guided
login flow is introduced by S2. Launching with the bound home belongs to S3;
person-confirmed switching belongs to the later switch story.

## Provider launch homes (Accounts S3)

`providerAccountEnv(account, parentEnv)` in `src/core/accounts.ts` returns a
fresh environment without credential or filesystem I/O. Its required typed
`ProviderAccountHome` carries `provider`, absolute `home` and `legacy`.
Managed accounts (`legacy: false`) replace both home-variable names
case-insensitively and set the selected provider's stored home. Legacy accounts
(`legacy: true`) preserve the parent's home-variable presence and values exactly,
including leaving them unset. Their recorded resolved directory is a reference,
not an environment override: explicitly setting a default Claude directory
changes its global configuration lookup. No account-book migration is needed.
S4 must carry the `legacy` flag when reusing this helper for provider-owned
identity/status subprocesses.

Production `SessionHost.accountById` resolves the persisted binding before either
immediate or deferred launch, fresh or resumed. The observed Take Over TUI
also resolves that same binding before its terminal opens, keeping its existing
MCP attribution separate from the home. An unknown account, mismatched
provider or invalid home refuses the start. Workspace service variables cannot
choose either provider home. The driver and model-probe allow-lists explicitly
admit the managed or inherited home; all existing trust, MCP and interpreter
options remain.

Provider-only login, Design login and provider-wide health/model probes still
select the legacy account. The existing window gets that persisted legacy home
and its inheritance flag from genie-host, reloads them on reconnect, and never
opens the account book.
Login captures its environment before opening the terminal and uses the same
home for the completion status command. Missing metadata is unknown and a login
refuses visibly. Closing a Design terminal still does not prove authorization.
Per-account login orchestration and person-confirmed switching remain S6/S9.

These tests prove environment selection and host wiring with inert process
ports. They do not prove real subscription isolation or Design authorization;
the owner-arranged VM measurements retain those claims.
