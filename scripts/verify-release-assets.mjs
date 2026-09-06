import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function requiredAssetNames(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Invalid version tag');
  const version = tag.slice(1);
  const signed = [
    'Lumen_aarch64.app.tar.gz', 'Lumen_x64.app.tar.gz',
    `Lumen_${version}_amd64.AppImage`, `Lumen_${version}_amd64.deb`,
    `Lumen-${version}-1.x86_64.rpm`, `Lumen_${version}_x64_en-US.msi`,
    `Lumen_${version}_x64-setup.exe`,
  ];
  return ['latest.json', `Lumen_${version}_aarch64.dmg`, `Lumen_${version}_x64.dmg`,
    ...signed.flatMap(name => [name, `${name}.sig`])];
}

// Checks completeness and references; installer launch and cryptographic
// verification of downloaded updater packages remain release review steps.
export function verifyReleaseAssets(tag, repo, assets, updater) {
  const names = new Set(assets.map(asset => asset.name));
  for (const name of requiredAssetNames(tag)) {
    const asset = assets.find(item => item.name === name);
    if (!asset) throw new Error(`Missing release asset: ${name}`);
    if (!(asset.size > 0) || asset.state !== 'uploaded') throw new Error(`Incomplete or empty asset: ${name}`);
  }
  if (updater.version !== tag.slice(1)) throw new Error('Updater version does not match release');
  for (const platform of ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64']) {
    if (!updater.platforms?.[platform]) throw new Error(`Missing updater platform: ${platform}`);
  }
  const prefix = `https://github.com/${repo}/releases/download/${tag}/`;
  for (const [platform, entry] of Object.entries(updater.platforms)) {
    if (typeof entry.signature !== 'string' || !entry.signature.trim()) throw new Error(`Missing signature: ${platform}`);
    if (typeof entry.url !== 'string' || !entry.url.startsWith(prefix)) throw new Error(`Wrong release URL: ${platform}`);
    const name = decodeURIComponent(entry.url.slice(prefix.length));
    if (!names.has(name) || !names.has(`${name}.sig`)) throw new Error(`Updater references absent signed asset: ${platform}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tag, repo, assetsPath, updaterPath] = process.argv.slice(2);
  if (!updaterPath) throw new Error('Usage: verify-release-assets.mjs TAG REPO ASSETS_JSON UPDATER_JSON');
  const { assets } = JSON.parse(readFileSync(assetsPath, 'utf8'));
  verifyReleaseAssets(tag, repo, assets, JSON.parse(readFileSync(updaterPath, 'utf8')));
  console.log(`Validated release manifest for ${tag}: ${assets.length} assets`);
}
