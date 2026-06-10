# Security policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security
vulnerabilities. Instead:

- Use GitHub's [private security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  feature on this repository.
- Or email **security@tynn.ai** with details.

We'll acknowledge receipt within 3 business days and aim to ship a fix
or mitigation within 30 days. Coordinated disclosure preferred — let us
ship before publishing details.

## Scope

Things we care about:

- **Token / secret leakage.** Genie stores a GitHub OAuth token via
  Electron's `safeStorage` (OS keychain). It also reads / writes
  `genie_token` (Tynn handoff cookie) in Electron's default session
  cookie store. Any path that exfiltrates either to a non-owner
  process, log, or disk file is in scope.
- **Local privilege escalation.** Genie spawns PTYs and runs git /
  npm / nextron during the updater flow. Any way to inject commands
  through workspace metadata (e.g. a maliciously-named git remote, a
  crafted `project.json`) is in scope.
- **Code execution from untrusted workspace folders.** A workspace
  the user opens should not be able to escape into Genie's process
  context (e.g. via xterm escape sequences that we don't sanitise).
- **Updater integrity.** The git-based updater pulls and rebuilds from
  the configured GitHub repo. Anything that lets an attacker substitute
  the update source, force a rebuild against arbitrary code, or
  persist beyond restart is in scope.

## Out of scope

- Vulnerabilities in third-party dependencies that don't have a path
  through Genie's code. Please report those upstream and let us know if
  Genie's usage makes it worse.
- Social-engineering attacks on the user (e.g. tricking them into
  pasting a token, approving a Device Flow they didn't initiate). Genie
  can't reasonably defend against these end-to-end; we try to label and
  caveat sensitive actions but ultimately the user is the trust anchor.
- Issues that require the attacker to already have local execution as
  the same user (the security model assumes the user owns their
  machine; if they don't, Genie isn't the right layer to fix that).
