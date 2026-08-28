const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const PETS_DIR = path.join(DATA_DIR, 'pets');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const MAX_PERSONA_TEXT_LENGTH = 50000;

const DEFAULT_SETTINGS = Object.freeze({
  version: 2,
  api: {
    textBaseUrl: 'https://api.openai.com/v1',
    textApiKey: '',
    textModel: 'gpt-4.1-mini',
    visionBaseUrl: '',
    visionApiKey: '',
    visionModel: '',
    temperature: 0.7
  },
  persona: {
    name: '小列',
    relationship: '值得信任的搭档',
    description: '友好、简洁、会主动说明电脑操作影响的桌面助理。',
    examples: '用户：帮我打开记事本\n小列：可以。我会先请求你的确认，再打开记事本。'
  },
  pet: {
    idleAssetPath: '',
    standingAssetPath: '',
    interactionAssetPath: '',
    movingAssetPath: '',
    deleteAnimationAssetPath: '',
    // masterScale is a multiplier shared by all display states.  The
    // individual values remain independent so the master slider never
    // overwrites a user's per-state tuning.
    masterScale: 1,
    idleScale: 1,
    standingScale: 1,
    interactionScale: 1,
    movingScale: 1,
    deleteScale: 1,
    scale: 1
  },
  ui: {
    skin: 'classic'
  },
  update: {
    repository: ''
  },
  automation: {
    enabled: false,
    autoExecute: false,
    perchOffsetPx: 0,
    wechatMonitorEnabled: false,
    wechatAutoReply: false,
    wechatIntervalMs: 5000,
    // Proactive, persona-aware wellness prompts.  They are intentionally
    // conservative so a fresh install is helpful without becoming noisy.
    wellbeingEnabled: true,
    wellbeingMinIntervalMs: 45 * 60 * 1000,
    wellbeingLongUseThresholdMs: 90 * 60 * 1000
  }
});

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function mergeSettings(saved = {}) {
  const result = cloneDefault();
  for (const group of ['api', 'persona', 'pet', 'ui', 'update', 'automation']) {
  if (saved[group] && typeof saved[group] === 'object') {
      Object.assign(result[group], saved[group]);
    }
  }
  // Migrate the former single scale slider and clamp all display scales to
  // the supported 20%–200% range.
  const savedPet = saved.pet && typeof saved.pet === 'object' ? saved.pet : {};
  const legacyScale = Object.prototype.hasOwnProperty.call(savedPet, 'masterScale')
    ? savedPet.masterScale
    : savedPet.scale;
  result.pet.masterScale = normalizePetScale(legacyScale, 1);
  result.pet.idleScale = normalizePetScale(savedPet.idleScale, 1);
  result.pet.standingScale = normalizePetScale(savedPet.standingScale, 1);
  result.pet.interactionScale = normalizePetScale(savedPet.interactionScale, 1);
  result.pet.movingScale = normalizePetScale(savedPet.movingScale, 1);
  result.pet.deleteScale = normalizePetScale(savedPet.deleteScale, 1);
  result.pet.scale = result.pet.masterScale;
  result.automation.perchOffsetPx = Math.min(160, Math.max(-160, Math.round(Number(result.automation.perchOffsetPx) || 0)));
  result.automation.wellbeingEnabled = result.automation.wellbeingEnabled !== false;
  result.automation.wellbeingMinIntervalMs = Math.min(180 * 60 * 1000, Math.max(10 * 60 * 1000, Math.round(Number(result.automation.wellbeingMinIntervalMs) || 45 * 60 * 1000)));
  result.automation.wellbeingLongUseThresholdMs = Math.min(240 * 60 * 1000, Math.max(30 * 60 * 1000, Math.round(Number(result.automation.wellbeingLongUseThresholdMs) || 90 * 60 * 1000)));
  if (!['classic', 'refined', 'reference', 'pepe'].includes(result.ui.skin)) result.ui.skin = 'classic';
  // Existing projects used the enabled switch as the user's permission for
  // computer actions. Preserve that consent when migrating to auto execution.
  if (!saved.automation || typeof saved.automation.autoExecute !== 'boolean') {
    result.automation.autoExecute = result.automation.enabled === true;
  }
  // Migrate the original single-model setting to the text model. The vision
  // model remains empty until the user explicitly configures one.
  if (!result.api.textModel && typeof saved.api?.model === 'string') {
    result.api.textModel = saved.api.model.trim();
  }
  if (typeof saved.api?.textModel !== 'string' && typeof saved.api?.model === 'string') {
    result.api.textModel = saved.api.model.trim();
  }
  if (typeof saved.api?.textBaseUrl !== 'string' && typeof saved.api?.baseUrl === 'string') {
    result.api.textBaseUrl = saved.api.baseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof saved.api?.textApiKey !== 'string' && typeof saved.api?.apiKey === 'string') {
    result.api.textApiKey = saved.api.apiKey;
  }
  if (typeof saved.api?.visionBaseUrl !== 'string' && typeof saved.api?.visionUrl === 'string') {
    result.api.visionBaseUrl = saved.api.visionUrl.trim().replace(/\/+$/, '');
  }
  delete result.api.baseUrl;
  delete result.api.apiKey;
  delete result.api.visionUrl;
  delete result.api.model;
  // Migrate the original single image setting to the new idle-state asset.
  if (!result.pet.idleAssetPath && typeof saved.pet?.assetPath === 'string') {
    result.pet.idleAssetPath = saved.pet.assetPath;
  }
  result.version = DEFAULT_SETTINGS.version;
  return result;
}

function ensureDataDirectories() {
  fs.mkdirSync(PETS_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(cloneDefault(), null, 2)}\n`, 'utf8');
  }
}

function readSettings() {
  ensureDataDirectories();
  try {
    return mergeSettings(JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')));
  } catch (error) {
    const recoveryPath = `${SETTINGS_PATH}.broken-${Date.now()}`;
    try {
      fs.renameSync(SETTINGS_PATH, recoveryPath);
    } catch {
      // A read-only recovery failure should not prevent the desktop pet starting.
    }
    const fallback = cloneDefault();
    fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(fallback, null, 2)}\n`, 'utf8');
    return fallback;
  }
}

function writeSettings(settings) {
  ensureDataDirectories();
  const tempPath = `${SETTINGS_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, SETTINGS_PATH);
}

function asText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizePetScale(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(2, Math.max(0.2, numeric));
}

function saveSettings(patch) {
  const current = readSettings();
  const next = mergeSettings(current);
  const input = patch && typeof patch === 'object' ? patch : {};

  if (input.api && typeof input.api === 'object') {
    const api = input.api;
    if (typeof api.textBaseUrl === 'string') next.api.textBaseUrl = api.textBaseUrl.trim().replace(/\/+$/, '');
    if (typeof api.baseUrl === 'string' && typeof api.textBaseUrl !== 'string') next.api.textBaseUrl = api.baseUrl.trim().replace(/\/+$/, '');
    if (typeof api.visionBaseUrl === 'string') next.api.visionBaseUrl = api.visionBaseUrl.trim().replace(/\/+$/, '');
    if (typeof api.textModel === 'string') next.api.textModel = api.textModel.trim();
    if (typeof api.model === 'string' && typeof api.textModel !== 'string') next.api.textModel = api.model.trim();
    if (typeof api.visionModel === 'string') next.api.visionModel = api.visionModel.trim();
    if (Number.isFinite(Number(api.temperature))) next.api.temperature = Math.min(1.5, Math.max(0, Number(api.temperature)));
    if (api.clearTextApiKey === true) next.api.textApiKey = '';
    if (api.clearVisionApiKey === true) next.api.visionApiKey = '';
    if (api.clearApiKey === true) next.api.textApiKey = '';
    if (typeof api.textApiKey === 'string' && api.textApiKey.trim()) next.api.textApiKey = api.textApiKey.trim();
    if (typeof api.visionApiKey === 'string' && api.visionApiKey.trim()) next.api.visionApiKey = api.visionApiKey.trim();
    if (typeof api.apiKey === 'string' && api.apiKey.trim() && typeof api.textApiKey !== 'string') next.api.textApiKey = api.apiKey.trim();
  }

  if (input.persona && typeof input.persona === 'object') {
    if (typeof input.persona.name === 'string') next.persona.name = asText(input.persona.name, '小列').slice(0, 40) || '小列';
    if (typeof input.persona.relationship === 'string') next.persona.relationship = asText(input.persona.relationship, '值得信任的搭档').slice(0, 80) || '值得信任的搭档';
    if (typeof input.persona.description === 'string') next.persona.description = input.persona.description.trim().slice(0, MAX_PERSONA_TEXT_LENGTH);
    if (typeof input.persona.examples === 'string') next.persona.examples = input.persona.examples.trim().slice(0, MAX_PERSONA_TEXT_LENGTH);
  }

  if (input.pet && typeof input.pet === 'object') {
    if (Object.prototype.hasOwnProperty.call(input.pet, 'masterScale')) {
      next.pet.masterScale = normalizePetScale(input.pet.masterScale, next.pet.masterScale);
      next.pet.scale = next.pet.masterScale;
    } else if (Object.prototype.hasOwnProperty.call(input.pet, 'scale')) {
      next.pet.masterScale = normalizePetScale(input.pet.scale, next.pet.masterScale);
      next.pet.scale = next.pet.masterScale;
    }
    for (const state of ['idle', 'standing', 'interaction', 'moving', 'delete']) {
      const key = `${state}Scale`;
      if (Object.prototype.hasOwnProperty.call(input.pet, key)) {
        next.pet[key] = normalizePetScale(input.pet[key], next.pet[key]);
      }
    }
  }

  if (input.ui && typeof input.ui === 'object') {
    if (['classic', 'refined', 'reference', 'pepe'].includes(input.ui.skin)) next.ui.skin = input.ui.skin;
  }

  if (input.update && typeof input.update === 'object') {
    if (typeof input.update.repository === 'string') next.update.repository = input.update.repository.trim().slice(0, 200);
  }

  if (input.automation && typeof input.automation === 'object') {
    if (Object.prototype.hasOwnProperty.call(input.automation, 'enabled')) next.automation.enabled = input.automation.enabled === true;
    if (Object.prototype.hasOwnProperty.call(input.automation, 'autoExecute')) next.automation.autoExecute = input.automation.autoExecute === true;
    if (Number.isFinite(Number(input.automation.perchOffsetPx))) {
      next.automation.perchOffsetPx = Math.min(160, Math.max(-160, Math.round(Number(input.automation.perchOffsetPx))));
    }
    if (Object.prototype.hasOwnProperty.call(input.automation, 'wechatMonitorEnabled')) next.automation.wechatMonitorEnabled = input.automation.wechatMonitorEnabled === true;
    if (Object.prototype.hasOwnProperty.call(input.automation, 'wechatAutoReply')) next.automation.wechatAutoReply = input.automation.wechatAutoReply === true;
    if (Number.isFinite(Number(input.automation.wechatIntervalMs))) {
      next.automation.wechatIntervalMs = Math.min(30000, Math.max(3000, Math.round(Number(input.automation.wechatIntervalMs))));
    }
    if (Object.prototype.hasOwnProperty.call(input.automation, 'wellbeingEnabled')) next.automation.wellbeingEnabled = input.automation.wellbeingEnabled === true;
    if (Number.isFinite(Number(input.automation.wellbeingMinIntervalMs))) {
      next.automation.wellbeingMinIntervalMs = Math.min(180 * 60 * 1000, Math.max(10 * 60 * 1000, Math.round(Number(input.automation.wellbeingMinIntervalMs))));
    }
    if (Number.isFinite(Number(input.automation.wellbeingLongUseThresholdMs))) {
      next.automation.wellbeingLongUseThresholdMs = Math.min(240 * 60 * 1000, Math.max(30 * 60 * 1000, Math.round(Number(input.automation.wellbeingLongUseThresholdMs))));
    }
  }

  writeSettings(next);
  return next;
}

function isProjectPet(filePath) {
  const resolved = path.resolve(filePath || '');
  return resolved.startsWith(`${path.resolve(PETS_DIR)}${path.sep}`);
}

function importPetAsset(sourcePath, state = 'idle') {
  ensureDataDirectories();
  const targetKey = state === 'moving'
    ? 'movingAssetPath'
    : state === 'standing'
      ? 'standingAssetPath'
      : state === 'interaction'
        ? 'interactionAssetPath'
        : state === 'delete'
          ? 'deleteAnimationAssetPath'
          : state === 'idle'
            ? 'idleAssetPath'
            : '';
  if (!targetKey) throw new Error('桌宠素材状态无效。');
  const validExtensions = new Set(['.gif', '.webm']);
  const source = path.resolve(sourcePath);
  const extension = path.extname(source).toLowerCase();
  if (!validExtensions.has(extension)) throw new Error('只支持 GIF 或 WEBM 动图。');
  const stat = fs.statSync(source);
  const maxBytes = state === 'interaction' ? 100 * 1024 * 1024 : 40 * 1024 * 1024;
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(`动图大小不得超过 ${state === 'interaction' ? 100 : 40}MB。`);

  const destination = path.join(PETS_DIR, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  fs.copyFileSync(source, destination);
  const settings = readSettings();
  settings.pet[targetKey] = destination;
  writeSettings(settings);
  return destination;
}

function gifDurationMs(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    if (data.length < 13 || data.toString('ascii', 0, 3) !== 'GIF') return 3200;
    let offset = 13;
    const packed = data[10];
    if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
    let totalDelay = 0;
    let frameCount = 0;
    while (offset < data.length) {
      const marker = data[offset++];
      if (marker === 0x3b) break;
      if (marker === 0x21) {
        const label = data[offset++];
        if (label === 0xf9 && offset < data.length) {
          const blockSize = data[offset++];
          if (blockSize >= 4 && offset + blockSize <= data.length) {
            const delay = data.readUInt16LE(offset + 1);
            totalDelay += delay || 10;
          }
          offset += blockSize;
          if (data[offset] === 0) offset += 1;
        } else {
          while (offset < data.length) {
            const blockSize = data[offset++];
            if (!blockSize) break;
            offset += blockSize;
          }
        }
        continue;
      }
      if (marker === 0x2c) {
        if (offset + 9 > data.length) break;
        const imagePacked = data[offset + 8];
        offset += 9;
        if (imagePacked & 0x80) offset += 3 * (2 ** ((imagePacked & 0x07) + 1));
        if (offset >= data.length) break;
        offset += 1; // LZW minimum code size
        while (offset < data.length) {
          const blockSize = data[offset++];
          if (!blockSize) break;
          offset += blockSize;
        }
        frameCount += 1;
        continue;
      }
      break;
    }
    const duration = totalDelay > 0 ? totalDelay * 10 : frameCount * 100;
    return Math.min(12000, Math.max(150, duration || 3200));
  } catch {
    return 3200;
  }
}

function toPublicPetAsset(assetPath) {
  const pathIsSafe = assetPath && isProjectPet(assetPath) && fs.existsSync(assetPath);
  const extension = path.extname(assetPath || '').toLowerCase();
  if (!pathIsSafe || !['.gif', '.webm'].includes(extension)) return { url: '', type: '' };
  const asset = {
    url: pathToFileURL(assetPath).href,
    type: extension === '.webm' ? 'webm' : 'gif'
  };
  if (asset.type === 'gif') asset.durationMs = gifDurationMs(assetPath);
  return asset;
}

function toPublicSettings(settings = readSettings()) {
  const copy = mergeSettings(settings);
  return {
    ...copy,
    api: {
      textBaseUrl: copy.api.textBaseUrl,
      visionBaseUrl: copy.api.visionBaseUrl,
      textModel: copy.api.textModel,
      visionModel: copy.api.visionModel,
      temperature: copy.api.temperature,
      textApiKeySet: Boolean(copy.api.textApiKey),
      visionApiKeySet: Boolean(copy.api.visionApiKey)
    },
    pet: {
      scale: copy.pet.masterScale,
      masterScale: copy.pet.masterScale,
      idleScale: copy.pet.idleScale,
      standingScale: copy.pet.standingScale,
      interactionScale: copy.pet.interactionScale,
      movingScale: copy.pet.movingScale,
      deleteScale: copy.pet.deleteScale,
      idle: toPublicPetAsset(copy.pet.idleAssetPath),
      standing: toPublicPetAsset(copy.pet.standingAssetPath),
      interaction: toPublicPetAsset(copy.pet.interactionAssetPath),
      moving: toPublicPetAsset(copy.pet.movingAssetPath),
      deleteAnimation: toPublicPetAsset(copy.pet.deleteAnimationAssetPath)
    }
  };
}

module.exports = {
  PROJECT_ROOT,
  DATA_DIR,
  SETTINGS_PATH,
  ensureDataDirectories,
  importPetAsset,
  readSettings,
  saveSettings,
  toPublicSettings
};
