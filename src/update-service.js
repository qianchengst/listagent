const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PACKAGE_PATH = path.join(PROJECT_ROOT, 'package.json');
const UPDATE_DIR = path.join(PROJECT_ROOT, '.runtime', 'updates');
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function packageInfo() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function normalizeRepository(value) {
  const raw = String(value || '').trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!raw) return '';
  const match = raw.match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i);
  return match ? `${match[1]}/${match[2]}` : '';
}

function configuredRepository(settings = {}) {
  const fromSettings = normalizeRepository(settings.update?.repository);
  if (fromSettings) return fromSettings;
  const repository = packageInfo().repository;
  return normalizeRepository(typeof repository === 'string' ? repository : repository?.url);
}

function parseVersion(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function currentVersion() {
  return String(packageInfo().version || '0.0.0');
}

function selectAsset(assets = []) {
  return assets
    .filter((asset) => asset && typeof asset.browser_download_url === 'string' && /\.zip$/i.test(asset.name || ''))
    .sort((left, right) => {
      const score = (asset) => /windows|portable|listagent/i.test(asset.name || '') ? 1 : 0;
      return score(right) - score(left);
    })[0] || null;
}

async function getUpdateInfo(settings = {}) {
  const repository = configuredRepository(settings);
  const version = currentVersion();
  if (!repository) {
    return { configured: false, repository: '', currentVersion: version, updateAvailable: false };
  }
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'listagent-update-checker'
    }
  });
  if (!response.ok) throw new Error(`GitHub 更新检查失败（HTTP ${response.status}）。`);
  const release = await response.json();
  const latestVersion = String(release.tag_name || release.name || '').replace(/^v/i, '') || version;
  const asset = selectAsset(release.assets);
  return {
    configured: true,
    repository,
    currentVersion: version,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, version) > 0,
    releaseName: release.name || release.tag_name || latestVersion,
    releaseUrl: release.html_url || `https://github.com/${repository}/releases`,
    publishedAt: release.published_at || '',
    notes: String(release.body || '').slice(0, 4000),
    asset: asset ? {
      name: asset.name,
      size: Number(asset.size) || 0,
      downloadUrl: asset.browser_download_url,
      digest: asset.digest || ''
    } : null
  };
}

async function downloadUpdate(updateInfo) {
  const asset = updateInfo?.asset;
  if (!asset?.downloadUrl || !/^https:\/\/github\.com\//i.test(asset.downloadUrl)) {
    throw new Error('此版本没有可下载的 Windows 更新包。');
  }
  if (asset.size > MAX_DOWNLOAD_BYTES) throw new Error('更新包超过允许的大小限制。');
  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  const filename = `listagent-${updateInfo.latestVersion || Date.now()}.zip`.replace(/[^a-zA-Z0-9._-]/g, '_');
  const temporaryPath = path.join(UPDATE_DIR, `${filename}.part`);
  const archivePath = path.join(UPDATE_DIR, filename);
  const response = await fetch(asset.downloadUrl, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'listagent-update-downloader' }
  });
  if (!response.ok) throw new Error(`更新包下载失败（HTTP ${response.status}）。`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('下载的更新包超过允许的大小限制。');
  if (asset.digest && /^sha256:/i.test(asset.digest)) {
    const expected = asset.digest.slice(7).toLowerCase();
    const actual = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actual !== expected) throw new Error('更新包校验失败，已阻止安装。');
  }
  fs.writeFileSync(temporaryPath, buffer);
  fs.renameSync(temporaryPath, archivePath);
  return archivePath;
}

module.exports = { configuredRepository, compareVersions, currentVersion, getUpdateInfo, downloadUpdate };
