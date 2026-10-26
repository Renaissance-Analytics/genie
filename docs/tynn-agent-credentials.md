# Tynn agent credentials

Genie prepares a separate Tynn identity and MCP key for each agent in a linked workspace before starting Claude or Codex. The binding includes the signed-in Tynn account, linked project and Genie agent ID. Restarting an agent reuses its encrypted key after checking that Tynn still considers the identity and key active.

The desktop pairing credential lives in `~/.genie/credentials/tynn.json`. Agent keys live in the separate sibling `~/.genie/agent-credentials/agents.json`. OS encryption and private filesystem permissions are required. Project files cannot select either storage path. No agent key is written to the workspace's MCP configs or returned in the session status.

An unlinked workspace and the workstation agent receive no Tynn server. Their inherited `tynn` server is disabled for the session. Linked agents receive only their prepared private Tynn server, using Prism's per-session credential transport.

Startup stops if the account is signed out, Tynn is unreachable, encryption or private storage is unavailable, the identity conflicts, or its key is revoked or awaiting confirmation. Genie explains the failure and never uses a shared workspace key to recover. A stopped preparation cannot launch a provider later. A pending key request needs review in Tynn before another key is issued.

Config sync no longer requests a workspace token. Genie removes its old Tynn entries from `.mcp.json`, `.cursor/mcp.json` and its marked blocks in `.codex/config.toml`, including when ordinary harness sync is disabled. Unrelated servers and settings are preserved. An ambiguous or unreadable configuration stops preparation rather than discarding the file. Rename or remove a conflicting custom `tynn` entry before restarting the agent.

The JSON files have no ownership markers. The reserved `tynn` entry with Genie's canonical Tynn URL and simple bearer header is treated as legacy configuration. A custom endpoint, transport or extra field is preserved and reported for manual reconciliation. TOML marker examples inside strings are preserved and reported too.

Removing a config entry does not revoke the old key remotely or erase historical copies from backups or git history. Review and revoke obsolete shared keys in Tynn after migrating any external clients that still use them.

Users whose previous Genie sign-in depended on browser cookies must pair Tynn again. The scoped desktop pairing migration is separate from per-agent keys.
