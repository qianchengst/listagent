const test = require('node:test');
const assert = require('node:assert/strict');
const { readSettings, toPublicSettings } = require('../src/settings-service');
const { normalizeWindows } = require('../src/topmost-window-service');

test('public settings redact the API key', () => {
  const settings = readSettings();
  settings.api.textApiKey = 'never-expose-this-key';
  const publicSettings = toPublicSettings(settings);
  assert.equal('apiKey' in publicSettings.api, false);
  assert.equal(publicSettings.api.textApiKeySet, true);
  assert.equal(typeof publicSettings.persona.name, 'string');
});

test('automation permission migrates from the original enabled switch', () => {
  const publicSettings = toPublicSettings({ automation: { enabled: true } });
  assert.equal(publicSettings.automation.enabled, true);
  assert.equal(publicSettings.automation.autoExecute, true);
  assert.equal(publicSettings.automation.wechatMonitorEnabled, false);
});

test('legacy single model migrates to the text model and leaves vision explicit', () => {
  const publicSettings = toPublicSettings({ api: { model: 'legacy-text-model' } });
  assert.equal(publicSettings.api.textModel, 'legacy-text-model');
  assert.equal(publicSettings.api.visionModel, '');
});

test('text and vision connections remain independent', () => {
  const publicSettings = toPublicSettings({ api: {
    textBaseUrl: 'https://text.example/v1',
    textApiKey: 'text-secret',
    textModel: 'text-model',
    visionBaseUrl: 'https://vision.example/v1',
    visionApiKey: 'vision-secret',
    visionModel: 'vision-model'
  } });
  assert.equal(publicSettings.api.textBaseUrl, 'https://text.example/v1');
  assert.equal(publicSettings.api.visionBaseUrl, 'https://vision.example/v1');
  assert.equal(publicSettings.api.textApiKeySet, true);
  assert.equal(publicSettings.api.visionApiKeySet, true);
  assert.equal('textApiKey' in publicSettings.api, false);
  assert.equal('visionApiKey' in publicSettings.api, false);
});

test('update repository defaults to the official project when missing or blank', () => {
  assert.equal(toPublicSettings({}).update.repository, 'qianchengst/listagent');
  assert.equal(toPublicSettings({ update: { repository: '' } }).update.repository, 'qianchengst/listagent');
  assert.equal(toPublicSettings({ update: { repository: '  custom-owner/custom-repo  ' } }).update.repository, 'custom-owner/custom-repo');
});

test('Gitee update repository defaults to the official domestic mirror', () => {
  assert.equal(toPublicSettings({}).update.giteeRepository, 'qianchengst/listagent');
  assert.equal(toPublicSettings({ update: { giteeRepository: '' } }).update.giteeRepository, 'qianchengst/listagent');
  assert.equal(toPublicSettings({ update: { giteeRepository: '  custom-owner/custom-repo  ' } }).update.giteeRepository, 'custom-owner/custom-repo');
});

test('persona relationship is preserved and has a useful default', () => {
  const defaultSettings = toPublicSettings({ persona: {} });
  assert.equal(defaultSettings.persona.relationship, '值得信任的搭档');
  const customSettings = toPublicSettings({ persona: { relationship: '我的博士' } });
  assert.equal(customSettings.persona.relationship, '我的博士');
});

test('persona avatar is exposed as a safe public URL without leaking its path', () => {
  const publicSettings = toPublicSettings({ persona: { avatarPath: 'C:\\outside\\avatar.png' } });
  assert.deepEqual(publicSettings.persona.avatar, { url: '', type: '' });
  assert.equal('avatarPath' in publicSettings.persona, false);
});

test('ui skin is restricted to the supported choices', () => {
  assert.equal(toPublicSettings({ ui: { skin: 'refined' } }).ui.skin, 'refined');
  assert.equal(toPublicSettings({ ui: { skin: 'reference' } }).ui.skin, 'reference');
  assert.equal(toPublicSettings({ ui: { skin: 'pepe' } }).ui.skin, 'pepe');
  assert.equal(toPublicSettings({ ui: { skin: 'unknown' } }).ui.skin, 'classic');
});

test('pet scales expose independent 20%–200% values and a shared master scale', () => {
  const pet = toPublicSettings({ pet: {
    masterScale: 1.5,
    idleScale: 0.2,
    standingScale: 1.25,
    interactionScale: 0.05,
    movingScale: 2.4,
    deleteScale: 0.75
  } }).pet;
  assert.equal(pet.masterScale, 1.5);
  assert.equal(pet.idleScale, 0.2);
  assert.equal(pet.standingScale, 1.25);
  assert.equal(pet.interactionScale, 0.2);
  assert.equal(pet.movingScale, 2);
  assert.equal(pet.deleteScale, 0.75);
});

test('rest state and movement pause range expose safe defaults and bounds', () => {
  const defaults = toPublicSettings({}).automation;
  assert.equal(defaults.restMode, false);
  assert.equal(defaults.startAtLogin, false);
  assert.equal(defaults.restOffsetPx, 0);
  assert.equal(defaults.movementPauseMinMs, 30 * 1000);
  assert.equal(defaults.movementPauseMaxMs, 90 * 1000);
  const bounded = toPublicSettings({
    pet: { restScale: 3 },
    automation: { restMode: true, restOffsetPx: 999, movementPauseMinMs: 1, movementPauseMaxMs: 999999999 }
  });
  assert.equal(bounded.pet.restScale, 2);
  assert.equal(bounded.automation.restMode, true);
  assert.equal(bounded.automation.restOffsetPx, 200);
  assert.equal(bounded.automation.movementPauseMinMs, 10 * 1000);
  assert.equal(bounded.automation.movementPauseMaxMs, 10 * 60 * 1000);
  assert.equal('rest' in bounded.pet, true);
});

test('startup setting is normalized to a boolean', () => {
  assert.equal(toPublicSettings({ automation: { startAtLogin: true } }).automation.startAtLogin, true);
  assert.equal(toPublicSettings({ automation: { startAtLogin: 'yes' } }).automation.startAtLogin, false);
});

test('perch offset is bounded to a safe vertical range', () => {
  assert.equal(toPublicSettings({ automation: { perchOffsetPx: -500 } }).automation.perchOffsetPx, -160);
  assert.equal(toPublicSettings({ automation: { perchOffsetPx: 500 } }).automation.perchOffsetPx, 160);
});

test('wellbeing reminders expose conservative defaults and safe bounds', () => {
  const defaults = toPublicSettings({}).automation;
  assert.equal(defaults.wellbeingEnabled, true);
  assert.equal(defaults.wellbeingMinIntervalMs, 45 * 60 * 1000);
  assert.equal(defaults.wellbeingLongUseThresholdMs, 90 * 60 * 1000);
  const bounded = toPublicSettings({ automation: { wellbeingMinIntervalMs: 1, wellbeingLongUseThresholdMs: 999999999 } }).automation;
  assert.equal(bounded.wellbeingMinIntervalMs, 10 * 60 * 1000);
  assert.equal(bounded.wellbeingLongUseThresholdMs, 240 * 60 * 1000);
});

test('topmost window candidates require usable bounds', () => {
  const windows = normalizeWindows([
    { X: 100, Y: 200, Width: 500, Height: 320, ProcessId: 1, Title: '置顶窗口' },
    { X: 120, Y: 220, Width: 800, Height: 600, ProcessId: 3, Title: 'NVIDIA GeForce Overlay DT' },
    { X: 0, Y: 0, Width: 120, Height: 60, ProcessId: 2, Title: '忽略的小窗口' }
  ]);
  assert.deepEqual(windows, [{ x: 100, y: 200, width: 500, height: 320, processId: 1, title: '置顶窗口' }]);
});
