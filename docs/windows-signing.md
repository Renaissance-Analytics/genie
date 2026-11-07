# Windows release signing

Windows uses the `renaissance-analytics` Artifact Signing account in East US
(`https://eus.codesigning.azure.net`), public profile `genie-public`, publisher
`Renaissance Analytics`. Signing credentials are short lived: `azure/login@v2`
uses GitHub OIDC and the environment's `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and
`AZURE_SUBSCRIPTION_ID` variables. No client secret or certificate file is used.

The owner has configured the federated identities and approval gates externally:

| Job | GitHub environment | Permitted ref | Token permissions |
| --- | --- | --- | --- |
| Windows release | `release` | `v*` tags | contents write, id-token write |
| Branch-push / manual signing proof | `sign-test` | `next/release-signing` | contents read, id-token write |
| Linux release | none | existing release tag trigger | existing contents write |

The separate Windows job keeps the signing identity out of Linux. The Windows
build uses `--publish never`, verifies signatures, then uploads those exact files
into the draft using `gh release upload`. It does not rebuild after verification.
Linux's build, tests and electron-builder publication commands are unchanged.
The final draft gate needs both jobs. Publishing the draft is still the owner's step.

The upload is separate because `electron-builder --publish always` schedules publication
inside the build when artifacts are emitted. A workflow step after that command cannot
prevent an installer from uploading before its signature and updater checks run. Calling
builder again with a prepackaged app would rebuild/sign a new NSIS installer, producing
different bytes from the verified file. The `gh` upload streams the three files produced
by the completed builder without rebuilding or rewriting them, to the same tag's draft.

## Credential selection and the locked adapter

The [published TrustedSigning module](https://www.powershellgallery.com/packages/TrustedSigning/0.5.8/Content/TrustedSigning.psm1)
uses `DefaultAzureCredential`. Microsoft's [credential-chain documentation](https://learn.microsoft.com/en-us/dotnet/azure/sdk/authentication/credential-chains)
describes how it advances past unavailable credentials and includes the Azure CLI
session created by [azure/login's OIDC flow](https://github.com/Azure/login/tree/v2#login-with-openid-connect-oidc-recommended).
These fresh hosted runners have no configured client secret, token-file credential
or managed identity. The intended successful credential is the logged-in CLI;
the protected sign-test run must confirm success and measure probe overhead.

No `Exclude*Credential` parameters are passed. The existing lock stays at
[app-builder-lib 26.15.3](https://registry.npmjs.org/app-builder-lib/-/app-builder-lib-26.15.3.tgz).
Its `out/codeSign/windowsSignAzureManager.js` supports the configured Azure account,
profile, endpoint, publisher and digest/timestamp options without a dependency
change or vendor patch. A CI test evaluates that unmodified adapter and binds its
generated command in Windows PowerShell using a local command stub, without Azure access.

If probe latency proves material, Microsoft's documented `AZURE_TOKEN_CREDENTIALS`
environment variable can select a credential, but individual names such as
`AzureCliCredential` require Azure.Identity >=1.15.0. That is not enabled here:
first establish the signing module/dlib's actual Identity version and measure
the default chain in sign-test before choosing an environment override.

## Binary coverage

In that same pinned package, `out/winPackager.js`'s
`createTransformerForExtraFiles` signs `.exe` extra resources while copying them.
It applies to `resources/bin/genie-launch.exe` from #1642 without a custom signer.
**Only what ships unsigned is signed.** signtool's sign replaces a file's existing
signature, and electron-builder signs every file its rule selects without checking
for one. Measured on the unsigned package (`scripts/win-sign-plan.mjs`, run 42377299413;
`test/fixtures/win-packed-signatures.json`), `signExts: ['.dll']` re-signed 11
Microsoft-signed files: `d3dcompiler_47.dll`, and `conpty.dll` and `OpenConsole.exe` in
node-pty's conpty folders.

`signExts` therefore names the unsigned DLLs (dxcompiler, electron_wer, ffmpeg,
vk_swiftshader, vulkan-1, winpty) and excludes `!OpenConsole.exe`; every other `.exe`
is signed by electron-builder's default. Microsoft's files keep Microsoft's
signature. Covered:
- Genie.exe, the launcher, Caddy, fancy-pty's helper, winpty-agent and the unsigned
  Electron DLLs are signed.
- Microsoft's files keep their own signature.

Checked in three places:
- CI's `it packages (windows)` runs `win-sign-plan.mjs --check` on its unsigned
  package. It fails on any file the build would sign that another publisher signed,
  and on any unsigned `.exe`/`.dll` it would leave unsigned, such as a new DLL not
  added to `signExts`.
- The release and sign-test write the plan before `verify-windows-signatures.ps1`.
- The verifier then requires each file the build did not sign to keep its own
  publisher's valid signature. NSIS separately signs its installer,
uninstaller and staged elevate.exe (`out/targets/nsis/NsisTarget.js` and
`out/targets/nsis/nsisUtil.js`). The launcher must be integrated before sign-test;
the verifier deliberately fails if it is missing.

NSIS deletes the temporary signed uninstaller after embedding it in setup.exe.
The Windows afterPack hook wraps `signIf` to copy those bytes only after signing
succeeds, before NSIS embeds and deletes the original. The copy is retained at
`release/signature-evidence/nsis-uninstaller.exe`; a repeated build clears stale
evidence first. No installer is executed to obtain it.

`scripts/verify-windows-signatures.ps1`, shared by sign-test and release, requires
Genie.exe, the launcher, exactly one setup installer and retained uninstaller.
It checks every exe/dll recursively in win-unpacked plus the installer and retained
uninstaller: Authenticode status `Valid`, exact signer CN `Renaissance Analytics`,
and a timestamp certificate present. It prints each path, identity, timestamp
signer and SHA256, and writes `release/signature-evidence/windows-signatures.json`.
An invalid/missing item fails before any upload. There are no vendor/path exclusions.

Ordinary CI has no signing environment or OIDC permission. It explicitly sets
`win.signExecutable=false` for its Windows packaging leg, retaining resource/icon
editing. This opt-out is absent from the protected signing jobs. Their source guards
run alongside the ordinary test suite; `Windows signing guards` also runs the actual
PowerShell positive/negative fixture cases on Windows without signing permissions.

## Updater evidence after signing

The beta.59 release's actual Windows assets are `Genie-2.0.0-beta.59-setup.exe`,
`Genie-2.0.0-beta.59-setup.exe.blockmap` and `latest.yml`. Its metadata names that
same installer in both `path` and `files[0].url`. Later versions replace only the
version in those asset names; the updater's repository and channel are unchanged.

In the locked [26.15.3 package](https://registry.npmjs.org/app-builder-lib/-/app-builder-lib-26.15.3.tgz),
`out/targets/nsis/NsisTarget.js` awaits `packager.signIf(installerPath)` at line302,
creates the blockmap/update info at line309, then emits the completed artifact at
line314. `out/publish/updateInfoBuilder.js` uses that SHA512 (or hashes the completed
file). A source guard asserts this ordering. Publication policy `never` suppresses
network uploads while retaining the builder's generated updater metadata.

After Authenticode verification, both protected workflows fetch beta.59's current
release asset list with the repository's read token, then run
`scripts/verify-windows-update.cjs`. The verifier streams SHA512 over the finished
installer and requires it to equal **both** `latest.yml` checksum fields, with
matching version, size and exact path/URL. It requires the installer, blockmap and
metadata files to be nonempty and compares their names to the reference release
with only the version substituted. Metadata paths are never used to open files.

The log prints the exact latest.yml contents, finished installer SHA512 in base64,
both metadata SHA512 fields, a MATCH result, and the three file names/sizes/hashes.
The artifact contains all three updater files plus `signature-evidence/latest.yml`,
`installer.sha512`, `windows-update.json`, `updater-summary.txt`, the live beta.59
asset list and the signature evidence. Release uploads the same root installer,
blockmap and latest.yml after both verifiers pass. Ordinary Windows packaging CI
also exercises the updater verifier on its unsigned build with a reference fixture
copied from the actual beta.59 list; that proves packaging/hash wiring, while the
protected run applies it to actual signed bytes.

## Review and real signing proof

Each push to `next/release-signing` queues `sign-test.yml` at that exact head for
the protected environment's owner approval. It also retains workflow_dispatch for
later use. New pushes cancel a superseded run so approval targets the current head.
This branch-push trigger avoids a default-branch bootstrap; no change to main is needed.
After ordinary CI is green, the coordinator/owner approves the queued environment.
The workflow uploads the signed installer, blockmap, metadata and signature/updater evidence
only after verification. Check every `VALID` line, including the launcher,
uninstaller, installer and DLLs. No release is created by this workflow.

Unit/source tests cannot prove the Azure role, federation, service availability or
public trust chain. Only that protected run establishes actual signing. Branch pushes
queue approval as authorized; agents must not manually dispatch sign-test, request
or grant its approval, bootstrap main or trigger a release as part of PR preparation.
