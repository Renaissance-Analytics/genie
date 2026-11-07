// Run after electron-builder has finished and, in protected jobs, after Authenticode verification.
// Hash the bytes that will be uploaded; never regenerate the installer after this check.
const { createHash } = require('node:crypto');
const { copyFileSync, createReadStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { load, JSON_SCHEMA } = require('js-yaml');

async function sha512File(file) {
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('base64');
}

async function verifyWindowsUpdate({ releaseDir, version, baseline }) {
    const root = resolve(releaseDir);
    const evidence = join(root, 'signature-evidence');
    for (const name of ['windows-update.json', 'installer.sha512', 'latest.yml', 'updater-summary.txt']) {
        rmSync(join(evidence, name), { force: true });
    }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error('Invalid package version for Windows updater proof');
    }
    const baselineTag = 'v2.0.0-beta.59';
    if (baseline?.tagName !== baselineTag || !Array.isArray(baseline.assets)) throw new Error('Expected beta.59 baseline release asset list');
    const baselineVersion = baselineTag.slice(1);
    const referenceInstaller = `Genie-${baselineVersion}-setup.exe`;
    const referenceNames = [referenceInstaller, `${referenceInstaller}.blockmap`, 'latest.yml'];
    const baselineNames = baseline.assets.map((asset) => asset.name);
    if (!referenceNames.every((name) => baselineNames.includes(name))) throw new Error('Baseline asset names do not match beta.59 Windows updater assets');
    const names = referenceNames.map((name) => name.replace(baselineVersion, version));
    // Only validated expected basenames reach the filesystem; YAML paths/URLs are never opened.
    const assets = [];
    for (const name of names) {
        const file = join(root, name);
        const stat = statSync(file);
        if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty Windows updater asset: ${name}`);
        assets.push({ name, size: stat.size, sha512: await sha512File(file) });
    }
    const metadataRaw = readFileSync(join(root, 'latest.yml'), 'utf8');
    const metadata = load(metadataRaw, { schema: JSON_SCHEMA });
    const installer = assets[0];
    if (!metadata || metadata.version !== version) throw new Error('latest.yml version does not match package version');
    if (!Array.isArray(metadata.files) || metadata.files.length !== 1 || metadata.files[0]?.url !== installer.name || metadata.path !== installer.name) {
        throw new Error('latest.yml file URL/path does not match the beta.59-compatible installer name');
    }
    if (metadata.sha512 !== installer.sha512 || metadata.files[0].sha512 !== installer.sha512) {
        throw new Error('latest.yml SHA512 does not match the finished installer bytes (possible pre-signing checksum)');
    }
    if (metadata.files[0].size !== installer.size) throw new Error('latest.yml installer size does not match finished bytes');

    const proof = { version, baselineTag, baselineAssetNames: baselineNames, assets, installerSha512: installer.sha512,
        metadataSha512: metadata.sha512, filesSha512: metadata.files[0].sha512, matches: true };
    const summary = [
        `Windows updater proof: ${version}`,
        `Reference release: https://github.com/Renaissance-Analytics/genie/releases/tag/${baselineTag}`,
        `Reference Windows names: ${referenceNames.join(', ')}`,
        ...assets.map((asset) => `${asset.name} | ${asset.size} bytes | SHA512(base64): ${asset.sha512}`),
        `Finished installer SHA512(base64): ${installer.sha512}`,
        `latest.yml sha512: ${metadata.sha512}`,
        `latest.yml files[0].sha512: ${metadata.files[0].sha512}`,
        'MATCH: finished installer bytes, both latest.yml SHA512 fields, size and reference asset naming',
        'latest.yml contents:', metadataRaw,
    ].join('\n');
    mkdirSync(evidence, { recursive: true });
    copyFileSync(join(root, 'latest.yml'), join(evidence, 'latest.yml'));
    writeFileSync(join(evidence, 'windows-update.json'), JSON.stringify(proof, null, 2) + '\n');
    writeFileSync(join(evidence, 'installer.sha512'), `${installer.sha512}  ${installer.name}\n`);
    writeFileSync(join(evidence, 'updater-summary.txt'), summary + '\n');
    console.log(summary);
    return proof;
}

module.exports = { verifyWindowsUpdate };
if (require.main === module) {
    const releaseDir = process.argv[2] ?? 'release';
    const baselineFile = process.argv[3] ?? 'test/fixtures/windows-update-beta59.json';
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8').replace(/^\uFEFF/, ''));
    verifyWindowsUpdate({ releaseDir, version: require('../package.json').version, baseline }).catch((error) => {
        console.error(`Windows updater proof failed: ${error.message}`);
        process.exitCode = 1;
    });
}
