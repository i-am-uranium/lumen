import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyReleaseAssets, requiredAssetNames } from './verify-release-assets.mjs';

const tag = 'v0.15.0';
const repo = 'example/lumen';
function fixture() {
  const assets = requiredAssetNames(tag).map(name => ({ name, size: 12, state: 'uploaded' }));
  const targets = {
    'darwin-aarch64': 'Lumen_aarch64.app.tar.gz',
    'darwin-x86_64': 'Lumen_x64.app.tar.gz',
    'linux-x86_64': 'Lumen_0.15.0_amd64.AppImage',
    'windows-x86_64': 'Lumen_0.15.0_x64_en-US.msi',
  };
  const platforms = Object.fromEntries(Object.entries(targets).map(([key, name]) => [key, {
    url: `https://github.com/${repo}/releases/download/${tag}/${name}`, signature: 'signed-content',
  }]));
  return { assets, updater: { version: '0.15.0', platforms } };
}
test('accepts complete platform artifacts and matching updater references', () => {
  const { assets, updater } = fixture();
  assert.doesNotThrow(() => verifyReleaseAssets(tag, repo, assets, updater));
});
test('rejects missing and empty artifacts', () => {
  const { assets, updater } = fixture();
  assert.throws(() => verifyReleaseAssets(tag, repo, assets.slice(1), updater), /Missing/);
  assets[0].size = 0;
  assert.throws(() => verifyReleaseAssets(tag, repo, assets, updater), /empty/);
});
test('rejects wrong updater version, missing platform and unsigned reference', () => {
  const { assets, updater } = fixture();
  assert.throws(() => verifyReleaseAssets(tag, repo, assets, { ...updater, version: '0.14.0' }), /version/);
  updater.platforms['darwin-aarch64'].signature = '';
  assert.throws(() => verifyReleaseAssets(tag, repo, assets, updater), /signature/);
  delete updater.platforms['darwin-aarch64'];
  assert.throws(() => verifyReleaseAssets(tag, repo, assets, updater), /platform/);
});
test('rejects cross-repository, old-release and nonexistent updater assets', () => {
  for (const url of [
    'https://github.com/other/lumen/releases/download/v0.15.0/Lumen_aarch64.app.tar.gz',
    'https://github.com/example/lumen/releases/download/v0.14.0/Lumen_aarch64.app.tar.gz',
    'https://github.com/example/lumen/releases/download/v0.15.0/nonexistent.tar.gz',
  ]) {
    const { assets, updater } = fixture();
    updater.platforms['darwin-aarch64'].url = url;
    assert.throws(() => verifyReleaseAssets(tag, repo, assets, updater));
  }
});
