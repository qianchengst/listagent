const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeRelativePath, createDeltaPlan } = require('../src/update-service');

test('incremental update paths stay inside the packaged application surface', () => {
  assert.equal(safeRelativePath('src/main.js'), 'src/main.js');
  assert.equal(safeRelativePath('../data/settings.json'), null);
  assert.equal(safeRelativePath('.runtime/updates/payload'), null);
  assert.equal(safeRelativePath('node_modules/electron.exe'), null);
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
