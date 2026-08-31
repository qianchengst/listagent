const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  safeRelativePath, createDeltaPlan, compareVersions, MIN_DELTA_CLIENT_VERSION,
  normalizeGiteeRepository, configuredGiteeRepository, configuredUpdateSource, selectAssetParts
} = require('../src/update-service');

test('delta updates start with v0.2.9 clients', () => {
  assert.equal(MIN_DELTA_CLIENT_VERSION, '0.2.9');
  assert.equal(compareVersions('0.2.8', MIN_DELTA_CLIENT_VERSION), -1);
  assert.equal(compareVersions('0.2.9', MIN_DELTA_CLIENT_VERSION), 0);
  assert.equal(compareVersions('0.2.10', MIN_DELTA_CLIENT_VERSION), 1);
});

test('Gitee update repositories and source selection are normalized safely', () => {
  assert.equal(normalizeGiteeRepository('https://gitee.com/demo/listagent.git'), 'demo/listagent');
  assert.equal(normalizeGiteeRepository('demo/listagent'), 'demo/listagent');
  assert.equal(normalizeGiteeRepository('https://github.com/demo/listagent'), '');
  assert.equal(configuredGiteeRepository({ update: { giteeRepository: 'demo/listagent' } }), 'demo/listagent');
  assert.equal(configuredUpdateSource({ update: { source: 'gitee' } }), 'gitee');
  assert.equal(configuredUpdateSource({ update: { source: 'anything-else' } }), 'github');
});

test('incremental update paths stay inside the packaged application surface', () => {
  assert.equal(safeRelativePath('src/main.js'), 'src/main.js');
  assert.equal(safeRelativePath('../data/settings.json'), null);
  assert.equal(safeRelativePath('.runtime/updates/payload'), null);
  assert.equal(safeRelativePath('node_modules/electron.exe'), null);
});

test('Gitee split archives require contiguous numbered parts', () => {
  const base = 'https://gitee.com/qianchengst/listagent/releases/download/v0.2.13/';
  const parts = selectAssetParts([
    { name: 'listagent-windows-x64.zip.part02', size: 20, download_url: `${base}listagent-windows-x64.zip.part02` },
    { name: 'listagent-windows-x64.zip.part01', size: 10, download_url: `${base}listagent-windows-x64.zip.part01` },
    { name: 'notes.zip.part01', size: 10, download_url: `${base}notes.zip.part01` }
  ]);
  assert.equal(parts.name, 'listagent-windows-x64.zip');
  assert.deepEqual(parts.parts.map((part) => part.partIndex), [1, 2]);
  assert.equal(parts.size, 30);
  assert.equal(selectAssetParts([
    { name: 'listagent-windows-x64.zip.part01', size: 10, download_url: `${base}listagent-windows-x64.zip.part01` },
    { name: 'listagent-windows-x64.zip.part03', size: 10, download_url: `${base}listagent-windows-x64.zip.part03` }
  ]), null);
  const preferred = selectAssetParts([
    { name: 'listagent-windows-x64-v0.2.13.zip.part01', size: 100, download_url: `${base}old.part01` },
    { name: 'listagent-windows-x64-v0.2.13.zip.part02', size: 100, download_url: `${base}old.part02` },
    { name: 'listagent-windows-x64-v0.2.13-gitee.zip.part01', size: 1, download_url: `${base}new.part01` },
    { name: 'listagent-windows-x64-v0.2.13-gitee.zip.part02', size: 1, download_url: `${base}new.part02` }
  ]);
  assert.equal(preferred.name, 'listagent-windows-x64-v0.2.13-gitee.zip');
});

test('incremental update plan skips files whose hashes already match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listagent-update-test-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const content = Buffer.from('same local file');
    fs.writeFileSync(path.join(root, 'src', 'same.js'), content);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const manifest = {
      schema: 1,
      repository: 'qianchengst/listagent',
      files: [
        { path: 'src/same.js', sha256: hash, url: 'https://raw.githubusercontent.com/qianchengst/listagent/v0.2.9/src/same.js' },
        { path: 'renderer/new.css', sha256: 'a'.repeat(64), url: 'https://raw.githubusercontent.com/qianchengst/listagent/v0.2.9/renderer/new.css' }
      ]
    };
    const plan = createDeltaPlan(manifest, root, 'qianchengst/listagent');
    assert.deepEqual(plan.map((entry) => entry.path), ['renderer/new.css']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
