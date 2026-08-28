const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PACKAGE_PATH = path.join(PROJECT_ROOT, 'package.json');
const UPDATE_DIR = path.join(PROJECT_ROOT, '.runtime', 'updates');
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MANIFEST_NAME = 'listagent-update-manifest.json';
// Clients before v0.2.9 predate the delta-update protocol and must always use
// the portable archive, even when a newer Release also contains a manifest.
const MIN_DELTA_CLIENT_VERSION = '0.2.9';
const ALLOWED_ROOTS = new Set(['src', 'renderer', 'scripts', 'models']);
const ALLOWED_FILES = new Set([
  'package.json', 'package-lock.json', 'README.md', 'start-listagent.cmd',
  'uninstall-listagent.cmd', 'uninstall-listagent.ps1'
]);

function packageInfo() {
  try { return JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8')); } catch { return {}; }
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
  const a = parseVersion(left); const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function currentVersion() { return String(packageInfo().version || '0.0.0'); }

function isGithubUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com';
  } catch { return false; }
}

function isAllowedRawUrl(value, repository) {
  try {
    const url = new URL(String(value));
    const expectedPrefix = `/${repository}/`.toLowerCase();
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'raw.githubusercontent.com'
      && url.pathname.toLowerCase().startsWith(expectedPrefix);
  } catch { return false; }
}

function safeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.includes('\0') || path.posix.isAbsolute(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '..')) return null;
  if (!ALLOWED_FILES.has(normalized) && !ALLOWED_ROOTS.has(parts[0])) return null;
  return normalized;
}

function selectAsset(assets = []) {
  return assets
    .filter((asset) => asset && typeof asset.browser_download_url === 'string' && /\.zip$/i.test(asset.name || ''))
    .sort((left, right) => {
      const score = (asset) => /windows|portable|listagent/i.test(asset.name || '') ? 1 : 0;
      return score(right) - score(left);
    })[0] || null;
}

function selectManifestAsset(assets = []) {
  return assets.find((asset) => asset && String(asset.name || '').toLowerCase() === MANIFEST_NAME
    && typeof asset.browser_download_url === 'string') || null;
}

function normalizeAsset(asset) {
  return asset ? {
    name: asset.name,
    size: Number(asset.size) || 0,
    downloadUrl: asset.browser_download_url,
    digest: asset.digest || ''
  } : null;
}

function releaseAssetUrl(repository, tag, name) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${name}`;
}

async function readLimitedResponse(response, maxBytes, label, onProgress) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`${label}超过允许的大小限制。`);
  // Streaming keeps the renderer informed while a large GitHub asset downloads.
  // Older Electron/Node combinations may not expose a Web ReadableStream, so
  // retain the arrayBuffer fallback for those runtimes.
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`${label}超过允许的大小限制。`);
    onProgress?.(buffer.length, declared || buffer.length);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = Buffer.from(result.value || []);
    received += chunk.length;
    if (received > maxBytes) {
      try { await reader.cancel(); } catch { /* Best effort: the limit is enforced below. */ }
      throw new Error(`${label}超过允许的大小限制。`);
    }
    if (chunk.length) chunks.push(chunk);
    onProgress?.(received, declared);
  }
  const buffer = Buffer.concat(chunks, received);
  if (buffer.length > maxBytes) throw new Error(`${label}超过允许的大小限制。`);
  return buffer;
}

function verifyDigest(buffer, digest, message) {
  if (!digest || !/^sha256:/i.test(digest)) return;
  const expected = digest.slice(7).toLowerCase();
  const actual = crypto.createHash('sha256').update(buffer).digest('hex');
  if (actual !== expected) throw new Error(`${message}校验失败，已阻止安装。`);
}

async function getReleaseFromPublicPage(repository, version) {
  const response = await fetch(`https://github.com/${repository}/releases/latest`, {
    redirect: 'manual', headers: { Accept: 'text/html', 'User-Agent': 'listagent-update-checker' }
  });
  const location = response.headers.get('location') || '';
  const tagMatch = location.match(/\/releases\/tag\/([^/?#]+)/i);
  const latestVersion = tagMatch ? decodeURIComponent(tagMatch[1]).replace(/^v/i, '') : version;
  const tag = tagMatch ? decodeURIComponent(tagMatch[1]) : `v${latestVersion}`;
  return {
    configured: true, repository, currentVersion: version, latestVersion,
    updateAvailable: compareVersions(latestVersion, version) > 0,
    releaseName: latestVersion,
    releaseUrl: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
    publishedAt: '', notes: '', mode: compareVersions(version, MIN_DELTA_CLIENT_VERSION) >= 0 ? 'delta' : 'full',
    manifestAsset: { name: MANIFEST_NAME, size: 0, downloadUrl: releaseAssetUrl(repository, tag, MANIFEST_NAME), digest: '' },
    asset: { name: 'listagent-windows-x64.zip', size: 0, downloadUrl: releaseAssetUrl(repository, tag, 'listagent-windows-x64.zip'), digest: '' }
  };
}

async function getUpdateInfo(settings = {}) {
  const repository = configuredRepository(settings); const version = currentVersion();
  if (!repository) return { configured: false, repository: '', currentVersion: version, updateAvailable: false };
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'listagent-update-checker' }
  });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) return getReleaseFromPublicPage(repository, version);
    throw new Error(`GitHub 更新检查失败（HTTP ${response.status}）。`);
  }
  const release = await response.json();
  const latestVersion = String(release.tag_name || release.name || '').replace(/^v/i, '') || version;
  const manifestAsset = selectManifestAsset(release.assets); const asset = selectAsset(release.assets);
  const mode = manifestAsset && compareVersions(version, MIN_DELTA_CLIENT_VERSION) >= 0 ? 'delta' : 'full';
  return {
    configured: true, repository, currentVersion: version, latestVersion,
    updateAvailable: compareVersions(latestVersion, version) > 0,
    releaseName: release.name || release.tag_name || latestVersion,
    releaseUrl: release.html_url || `https://github.com/${repository}/releases`,
    publishedAt: release.published_at || '', notes: String(release.body || '').slice(0, 4000),
    mode, manifestAsset: normalizeAsset(manifestAsset), asset: normalizeAsset(asset)
  };
}

function createDeltaPlan(manifest, projectRoot = PROJECT_ROOT, repository = '') {
  if (!manifest || Number(manifest.schema) !== 1 || !Array.isArray(manifest.files)) throw new Error('更新清单格式无效。');
  const plan = [];
  for (const entry of manifest.files) {
    const relativePath = safeRelativePath(entry?.path);
    const expectedHash = String(entry?.sha256 || '').toLowerCase();
    if (!relativePath || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('更新清单包含不安全或无效的文件项。');
    if (!isAllowedRawUrl(entry?.url, repository || manifest.repository || '')) throw new Error(`更新清单中的下载地址无效：${relativePath}`);
    const localPath = path.join(projectRoot, ...relativePath.split('/')); let actualHash = '';
    try {
      if (fs.statSync(localPath).isFile()) actualHash = crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex');
    } catch { /* Missing local files are part of the delta. */ }
    if (actualHash !== expectedHash) plan.push({ path: relativePath, url: String(entry.url), sha256: expectedHash, size: Number(entry.size) || 0 });
  }
  return plan;
}

async function downloadManifest(updateInfo, onProgress) {
  const asset = updateInfo?.manifestAsset;
  if (!asset?.downloadUrl) return null;
  if (!isGithubUrl(asset.downloadUrl)) throw new Error('更新清单下载地址无效。');
  const response = await fetch(asset.downloadUrl, { headers: { Accept: 'application/json', 'User-Agent': 'listagent-update-downloader' } });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error(`更新清单下载失败（HTTP ${response.status}）。`);
  const buffer = await readLimitedResponse(response, MAX_MANIFEST_BYTES, '更新清单', (received, total) => {
    onProgress?.({ phase: 'manifest', downloaded: received, total, files: 0, completedFiles: 0 });
  });
  verifyDigest(buffer, asset.digest, '更新清单');
  try { return JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('更新清单不是有效的 JSON。'); }
}

async function downloadDeltaUpdate(updateInfo, manifest, onProgress) {
  const plan = createDeltaPlan(manifest, PROJECT_ROOT, updateInfo.repository);
  const total = plan.reduce((sum, entry) => sum + (Number(entry.size) || 0), 0);
  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  const versionLabel = String(updateInfo.latestVersion || Date.now()).replace(/[^a-zA-Z0-9._-]/g, '_');
  const payloadPath = path.join(UPDATE_DIR, `payload-${versionLabel}-${Date.now()}`);
  fs.mkdirSync(payloadPath, { recursive: true }); let bytes = 0;
  onProgress?.({ phase: 'download', downloaded: 0, total, files: plan.length, completedFiles: 0 });
  try {
    for (let index = 0; index < plan.length; index += 1) {
      const entry = plan[index];
      const fileBase = bytes;
      const response = await fetch(entry.url, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'listagent-update-downloader' } });
      if (!response.ok) throw new Error(`更新文件下载失败（${entry.path}，HTTP ${response.status}）。`);
      const buffer = await readLimitedResponse(response, MAX_DOWNLOAD_BYTES, `更新文件 ${entry.path}`, (received, declared) => {
        const progressTotal = total || (fileBase + (declared || 0));
        onProgress?.({
          phase: 'download', downloaded: fileBase + received, total: progressTotal,
          currentFile: entry.path, files: plan.length, completedFiles: index
        });
      });
      const actual = crypto.createHash('sha256').update(buffer).digest('hex');
      if (actual !== entry.sha256) throw new Error(`更新文件校验失败（${entry.path}），已阻止安装。`);
      const destination = path.join(payloadPath, ...entry.path.split('/')); fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temporaryPath = `${destination}.part`; fs.writeFileSync(temporaryPath, buffer); fs.renameSync(temporaryPath, destination); bytes += buffer.length;
      onProgress?.({ phase: 'download', downloaded: bytes, total, currentFile: entry.path, files: plan.length, completedFiles: index + 1 });
    }
  } catch (error) { fs.rmSync(payloadPath, { recursive: true, force: true }); throw error; }
  onProgress?.({ phase: 'complete', downloaded: bytes, total: total || bytes, files: plan.length, completedFiles: plan.length });
  return { kind: 'delta', payloadPath, files: plan.length, bytes };
}

async function downloadFullArchive(updateInfo, onProgress) {
  const asset = updateInfo?.asset;
  if (!asset?.downloadUrl || !isGithubUrl(asset.downloadUrl)) throw new Error('此版本没有可下载的 Windows 更新包。');
  if (asset.size > MAX_DOWNLOAD_BYTES) throw new Error('更新包超过允许的大小限制。');
  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  const filename = `listagent-${updateInfo.latestVersion || Date.now()}.zip`.replace(/[^a-zA-Z0-9._-]/g, '_');
  const temporaryPath = path.join(UPDATE_DIR, `${filename}.part`); const archivePath = path.join(UPDATE_DIR, filename);
  const response = await fetch(asset.downloadUrl, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'listagent-update-downloader' } });
  if (!response.ok) throw new Error(`更新包下载失败（HTTP ${response.status}）。`);
  onProgress?.({ phase: 'download', downloaded: 0, total: asset.size || 0, files: 1, completedFiles: 0 });
  const buffer = await readLimitedResponse(response, MAX_DOWNLOAD_BYTES, '更新包', (received, declared) => {
    onProgress?.({
      phase: 'download', downloaded: received, total: asset.size || declared || 0,
      currentFile: asset.name || 'listagent-windows-x64.zip', files: 1, completedFiles: 0
    });
  }); verifyDigest(buffer, asset.digest, '更新包');
  fs.writeFileSync(temporaryPath, buffer); fs.renameSync(temporaryPath, archivePath);
  onProgress?.({ phase: 'complete', downloaded: buffer.length, total: asset.size || buffer.length, files: 1, completedFiles: 1 });
  return { kind: 'archive', archivePath, files: null, bytes: buffer.length };
}

async function downloadUpdate(updateInfo, onProgress) {
  const supportsDelta = compareVersions(currentVersion(), MIN_DELTA_CLIENT_VERSION) >= 0;
  const manifest = supportsDelta ? await downloadManifest(updateInfo, onProgress) : null;
  if (manifest?.repository && normalizeRepository(manifest.repository) !== normalizeRepository(updateInfo?.repository)) throw new Error('更新清单与当前仓库不匹配。');
  if (manifest?.version && compareVersions(manifest.version, updateInfo?.latestVersion) !== 0) throw new Error('更新清单与 Release 版本不匹配。');
  const currentElectron = String(packageInfo().devDependencies?.electron || '').trim();
  const targetElectron = String(manifest?.runtime?.electron || '').trim();
  if (supportsDelta && manifest && !(currentElectron && targetElectron && currentElectron !== targetElectron)) return downloadDeltaUpdate(updateInfo, manifest, onProgress);
  return downloadFullArchive(updateInfo, onProgress);
}

module.exports = { configuredRepository, compareVersions, currentVersion, safeRelativePath, createDeltaPlan, getUpdateInfo, downloadUpdate, MIN_DELTA_CLIENT_VERSION };
