// app-builder-lib 26.17.0 quotes every Azure value, including Invoke-TrustedSigning's
// [switch] parameters. `-ExcludeEnvironmentCredential 'true'` fails PowerShell binding.
// Correct only the ten documented switches; keep upstream quoting for paths and strings.
// https://www.powershellgallery.com/packages/TrustedSigning/0.5.8/Content/TrustedSigning.psm1
// Explicit build step in the two protected Windows jobs, never an install script.
const { readFileSync, writeFileSync } = require('node:fs');

const marker = '// Genie: TrustedSigning credential switches require colon syntax.';
const original = String.raw`            const escapedValue = String(value).replace(/'/g, "''");`;
const replacement = String.raw`            // Genie: TrustedSigning credential switches require colon syntax.
            if (/^Exclude(?:Environment|WorkloadIdentity|ManagedIdentity|SharedTokenCache|VisualStudio|VisualStudioCode|AzureCli|AzurePowerShell|AzureDeveloperCli|InteractiveBrowser)Credential$/.test(field)) {
                const flag = String(value);
                if (flag !== "true" && flag !== "false") {
                    throw new Error("Expected true/false for TrustedSigning switch " + field);
                }
                return [...res, "-" + field + ":$" + flag];
            }
            const escapedValue = String(value).replace(/'/g, "''");`;

function patchAzureSwitches(source) {
    const text = source.replace(/\r\n/g, '\n');
    if (text.includes(marker)) return text;
    if (text.split(original).length !== 2) throw new Error('Azure signing adapter changed: re-review the switch correction');
    return text.replace(original, replacement);
}

module.exports = { patchAzureSwitches };
if (require.main === module) {
    const version = require('app-builder-lib/package.json').version;
    if (version !== '26.17.0') throw new Error(`Re-review Azure switch serialization for app-builder-lib ${version}`);
    const file = require.resolve('app-builder-lib/out/codeSign/windowsSignAzureManager.js');
    writeFileSync(file, patchAzureSwitches(readFileSync(file, 'utf8')));
    console.log(`Corrected TrustedSigning credential switch serialization in app-builder-lib ${version}`);
}
