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
| Manual signing proof | `sign-test` | `next/release-signing` | contents read, id-token write |
| Linux release | none | existing release tag trigger | existing contents write |

The separate Windows job keeps the signing identity out of Linux. The Windows
build uses `--publish never`, verifies signatures, then uploads those exact files
into the draft using `gh release upload`. It does not rebuild after verification.
Linux's build, tests and electron-builder publication commands are unchanged.
The final draft gate needs both jobs. Publishing the draft is still the owner's step.

## Credential selection and the pinned adapter

Microsoft documents `Invoke-TrustedSigning` authentication and the individual
`Exclude*Credential` switches in the [module's command documentation](https://www.powershellgallery.com/packages/TrustedSigning/0.5.8/Content/TrustedSigning-help.xml)
and [published implementation](https://www.powershellgallery.com/packages/TrustedSigning/0.5.8/Content/TrustedSigning.psm1).
The configuration excludes the other nine credential types, leaving
`AzureCliCredential` enabled to use the CLI login created by
[azure/login's OIDC flow](https://github.com/Azure/login/tree/v2#login-with-openid-connect-oidc-recommended).
`WorkloadIdentityCredential` is excluded too: this setup uses the CLI session,
not a workload-identity token file. The config uses the module's switch names;
`ExcludeCredentials` is a metadata.json field, not a parameter of that command.

The [published app-builder-lib 26.17.0 package](https://registry.npmjs.org/app-builder-lib/-/app-builder-lib-26.17.0.tgz)
contains `out/codeSign/windowsSignAzureManager.js`. It forwards additional Azure
options as command parameters, but quotes every value as a string. That makes
`ExcludeEnvironmentCredential: 'true'` become `-ExcludeEnvironmentCredential 'true'`,
which PowerShell refuses for a switch. This was reproduced on the Windows CI runner.
The config values are strings because electron-builder's Azure schema requires them.

`scripts/patch-azure-signing.cjs` corrects only those ten switch parameters to
PowerShell's `-Name:$true` / `-Name:$false` form. It is an explicit step in the two
protected Windows jobs, requires app-builder-lib 26.17.0 and the exact source
fragment, and fails if that adapter changes. It adds no install script and leaves
upstream path/string escaping intact. A CI test evaluates that actual adapter and
binds the resulting command in Windows PowerShell with a local command stub;
the stub has no Azure access. Remove the correction once a reviewed upstream
version handles switches correctly.

## Binary coverage

In that same pinned package, `out/winPackager.js`'s
`createTransformerForExtraFiles` signs `.exe` extra resources while copying them.
It applies to `resources/bin/genie-launch.exe` from #1642 without a custom signer.
The `signExts: ['.dll']` setting adds DLLs to that copy transformation and to the
root/app.asar.unpacked scans. This covers Genie.exe, Electron DLLs, Caddy, the
launcher, and unpacked native helpers. NSIS separately signs its installer,
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

## Review and real signing proof

After the PR's ordinary CI is green, the coordinator dispatches `sign-test.yml`
at the exact reviewed `next/release-signing` head and the owner approves its
environment. The workflow uploads the signed installer and signature evidence
only after verification. Check every `VALID` line, including the launcher,
uninstaller, installer and DLLs. No release is created by this workflow.

Unit/source tests cannot prove the Azure role, federation, service availability or
public trust chain. Only that protected run establishes actual signing. Agents must
not dispatch sign-test, request its approval or trigger a release as part of PR preparation.
