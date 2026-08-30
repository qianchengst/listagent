const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, powerMonitor, screen, shell } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const {
  PROJECT_ROOT,
  ensureDataDirectories,
  importPetAsset,
  importPersonaAvatar,
  readSettings,
  saveSettings,
  toPublicSettings
} = require('./settings-service');
const { analyzeWechatImage, chat, chatWithWechatImage, clearSession, decideAction, generateGreeting, generateWellbeingMessage, getModelUsageTotals, getSessionHistory, recordGreeting } = require('./agent-service');
const { finishSession, getRecord: getCompanionRecord, recordConversation, recordModelUsage, recordMovement, startSession } = require('./companion-record-service');
const { getWeChatStatus, captureWeChatWindow, sendTextToActiveWeChat } = require('./automation-service');
const { detectWeChatBubble, stopWorker } = require('./yolo-service');
const { findTopmostUnmaximizedWindows } = require('./topmost-window-service');
const { getUpdateInfo, downloadUpdate } = require('./update-service');

const execFileAsync = promisify(execFile);

const DELETE_ARG = '--listagent-delete';
const DELETE_ANIMATION_FALLBACK_MS = 3200;
// Electron screen coordinates use Windows DIP units: 96 DIP per inch.
const DELETE_LEFT_OFFSET_DIP = Math.round(96 / 2.54); // 1 cm ≈ 38 DIP

// Keep Electron's runtime and all application data inside this project directory.
app.setPath('userData', path.join(PROJECT_ROOT, '.runtime'));

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const target = deleteTargetFromArgv(commandLine);
    if (target) {
      void handleFileDeleteRequest(target);
      return;
    }
    openConsole();
  });
}

const PET_WIDTH = 240;
const PET_HEIGHT = 260;
// The previous shortest movement took 850ms. A 300 DIP/s linear pace is about
// one third of that former fastest desktop motion while remaining easy to follow.
const AUTO_MOVE_PIXELS_PER_SECOND = 300;
const PERCH_SNAP_DISTANCE_DIP = 86;
const PERCH_SNAP_MIN_OVERLAP_DIP = 44;
const MOVE_PAUSE_MIN_MS = 10 * 1000;
const MOVE_PAUSE_MAX_MS = 10 * 60 * 1000;
let petWindow;
let consoleWindow;
let bubbleWindow;
let wechatDebugWindow;
let confirmationWindow;
let pendingConfirmationPayload = [];
let userDragging = false;
let taskDepth = 0;
let autoMoving = false;
let randomMoveTimer;
let moveAnimationTimer;
let autoMoveWatchdogTimer;
let dragOriginPerchedWindowInfo;
let lockingPetViewport = false;
let perchedOnWindow = false;
let perchedWindowInfo;
let wechatMonitorTimer;
let wechatMonitorIntervalMs = 0;
let wechatMonitorBusy = false;
let wechatLastCaptureHash = '';
let wechatLastRepliedMessageKey = '';
let wellbeingTimer;
let wellbeingBusy = false;
let wellbeingUsageStartedAt = Date.now();
let wellbeingLastTriggerAt = 0;
const WELLBEING_POLL_MS = 60000;
const WELLBEING_IDLE_RESET_SECONDS = 15 * 60;
const WELLBEING_START_GRACE_MS = 5 * 60 * 1000;
const WELLBEING_ACTIVE_MEAL_THRESHOLD_MS = 30 * 60 * 1000;
const WELLBEING_ACTIVE_EYE_THRESHOLD_MS = 45 * 60 * 1000;
const greetingCache = new Map();
const greetingInFlight = new Map();
let lastWechatDebug = {
  state: 'idle',
  message: '尚未收到微信截图。',
  sender: 'unknown',
  senderReason: '',
  recognizedText: '',
  raw: '',
  imageDataUrl: '',
  captureMethod: '',
  captureWidth: 0,
  captureHeight: 0,
  timestamp: ''
};

let deleteRequestBusy = false;
let deleteRequestPath = '';
let petWindowScale = 1;
let restModeActive = false;
let companionRecordTimer;
let companionUsageCheckpoint = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedRequests: 0 };
const AUTO_MOVE_WATCHDOG_MS = 5000;

function deleteTargetFromArgv(argv = process.argv) {
  const values = Array.isArray(argv) ? argv.map((value) => String(value ?? '')) : [];
  const index = values.findIndex((value) => value === DELETE_ARG || value.startsWith(`${DELETE_ARG}=`));
  if (index < 0) return '';
  const inlineTarget = values[index].slice(DELETE_ARG.length + 1);
  if (inlineTarget) return path.resolve(inlineTarget.replace(/^"|"$/g, ''));
  // Electron inserts Chromium switches and the app path into the
  // second-instance array.  The file selected in Explorer is therefore not
  // necessarily the argument immediately after DELETE_ARG; use the last
  // non-switch argument after it (the selected path).
  const candidates = values
    .slice(index + 1)
    .map((value) => value.replace(/^"|"$/g, ''))
    .filter((value) => value && !value.startsWith('-'));
  const target = candidates.at(-1);
  return target ? path.resolve(target) : '';
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteWindowsCommand(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

async function registerWindowsContextMenu() {
  if (process.platform !== 'win32') return;
  // Use reg.exe for the default value.  The PowerShell registry provider can
  // silently create a literal property named "(default)" instead of the
  // registry key's unnamed value, leaving Explorer with an empty command.
  // That makes the menu visible but turns a click into a no-op.
  const key = 'HKCU\\Software\\Classes\\*\\shell\\ListagentDelete';
  const commandKey = `${key}\\command`;
  const label = '通过 listagent 删除';
  const command = process.defaultApp
    ? `${quoteWindowsCommand(process.execPath)} ${quoteWindowsCommand(app.getAppPath())} ${DELETE_ARG} "%1"`
    : `${quoteWindowsCommand(process.execPath)} ${DELETE_ARG} "%1"`;
  const options = { windowsHide: true };
  await execFileAsync('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', label, '/f'], options);
  await execFileAsync('reg.exe', ['ADD', key, '/v', 'Icon', '/t', 'REG_SZ', '/d', process.execPath, '/f'], options);
  await execFileAsync('reg.exe', ['ADD', commandKey, '/ve', '/t', 'REG_SZ', '/d', command, '/f'], options);
}

function syncLoginItemSettings(enabled) {
  const desired = enabled === true;
  if (process.platform !== 'win32' || typeof app.setLoginItemSettings !== 'function') return desired;
  const options = { openAtLogin: desired };
  // In development Electron is the executable, so the project path must be
  // passed as an argument. Packaged/portable builds use their own executable
  // path automatically and should not retain a development path.
  if (process.defaultApp) {
    options.path = process.execPath;
    options.args = [app.getAppPath()];
  }
  try {
    app.setLoginItemSettings(options);
    return desired;
  } catch (error) {
    console.warn(`设置开机自启动失败：${error.message}`);
    return false;
  }
}

function deleteAnimationAsset() {
  const pet = toPublicSettings(readSettings()).pet;
  return pet.deleteAnimation?.url
    ? pet.deleteAnimation
    : pet.moving?.url
      ? pet.moving
      : pet.idle?.url
        ? pet.idle
        : pet.standing?.url
          ? pet.standing
          : pet.rest;
}

function petDimensions(scale = petWindowScale) {
  const safeScale = Math.min(2, Math.max(0.2, Number(scale) || 1));
  return {
    width: Math.max(48, Math.round(PET_WIDTH * safeScale)),
    height: Math.max(52, Math.round(PET_HEIGHT * safeScale))
  };
}

function resizePetWindow(scale, preserveCenter = true) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const nextScale = Math.min(2, Math.max(0.2, Number(scale) || 1));
  const next = petDimensions(nextScale);
  const bounds = petWindow.getBounds();
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  petWindowScale = nextScale;
  petWindow.setMinimumSize(next.width, next.height);
  petWindow.setMaximumSize(next.width, next.height);
  petWindow.setContentSize(next.width, next.height);
  if (preserveCenter) {
    positionPet(center.x - next.width / 2, center.y - next.height / 2);
  }
  if (restModeActive && !perchedOnWindow && !userDragging) positionPetAtRestCorner();
}

async function explorerFileBounds(filePath) {
  if (process.platform !== 'win32') return undefined;
  const script = [
    'Add-Type -AssemblyName UIAutomationClient;',
    'Add-Type -AssemblyName UIAutomationTypes;',
    `$target=${quotePowerShell(filePath)};`,
    '$folderPath=[System.IO.Path]::GetDirectoryName($target);',
    '$name=[System.IO.Path]::GetFileName($target);',
    '$shell=New-Object -ComObject Shell.Application;',
    'foreach($window in $shell.Windows()){',
    'try{',
    'if([string]$window.Document.Folder.Self.Path -ne $folderPath){continue};',
    '$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$window.HWND);',
    '$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$name);',
    'foreach($el in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)){',
    '$rect=$el.Current.BoundingRectangle;',
    'if($rect.Width -gt 0 -and $rect.Height -gt 0){',
    '[pscustomobject]@{X=$rect.X;Y=$rect.Y;Width=$rect.Width;Height=$rect.Height}|ConvertTo-Json -Compress;exit 0;',
    '}',
    '}',
    '}catch{}',
    '}'
  ].join(' ');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 2000, maxBuffer: 1024 * 1024 }
    );
    const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!line) return undefined;
    const bounds = JSON.parse(line);
    if (![bounds.X, bounds.Y, bounds.Width, bounds.Height].every(Number.isFinite)) return undefined;
    return { x: bounds.X, y: bounds.Y, width: bounds.Width, height: bounds.Height };
  } catch {
    return undefined;
  }
}

async function deleteTargetPosition() {
  if (!petWindow || petWindow.isDestroyed()) return undefined;
  const { width, height } = petWindow.getBounds();
  const fileBounds = await explorerFileBounds(deleteRequestPath);
  if (fileBounds) {
    // The centre of the pet is placed exactly at the selected file's
    // lower-left corner.
    return {
      x: fileBounds.x - width / 2 - DELETE_LEFT_OFFSET_DIP,
      y: fileBounds.y + fileBounds.height - height / 2
    };
  }
  const cursor = screen.getCursorScreenPoint();
  return { x: cursor.x - width / 2 - DELETE_LEFT_OFFSET_DIP, y: cursor.y - height / 2 };
}

async function movePetToDeleteTarget() {
  const destination = await deleteTargetPosition();
  return movePetLinearly(destination, { perched: false });
}

function movePetLinearly(destination, metadata = {}) {
  if (!destination || !petWindow || petWindow.isDestroyed()) return Promise.resolve();
  const start = petWindow.getBounds();
  const target = {
    x: Math.round(destination.x),
    y: Math.round(destination.y)
  };
  const distance = Math.hypot(target.x - start.x, target.y - start.y);
  recordMovement(distance);
  emitMovementState(true);
  if (distance < 2) {
    emitMovementState(false, metadata);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const startTime = Date.now();
    const duration = Math.max(120, (distance / AUTO_MOVE_PIXELS_PER_SECOND) * 1000);
    const timer = setInterval(() => {
      if (!petWindow || petWindow.isDestroyed()) {
        clearInterval(timer);
        emitMovementState(false, metadata);
        resolve();
        return;
      }
      const progress = Math.min(1, (Date.now() - startTime) / duration);
      petWindow.setPosition(
        Math.round(start.x + (target.x - start.x) * progress),
        Math.round(start.y + (target.y - start.y) * progress)
      );
      if (progress >= 1) {
        clearInterval(timer);
        emitMovementState(false, metadata);
        resolve();
      }
    }, 16);
  });
}

function playDeleteAnimationAndWait(asset) {
  if (!asset?.url || !petWindow || petWindow.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const timeout = setTimeout(finish, asset.type === 'webm' ? 8200 : DELETE_ANIMATION_FALLBACK_MS + 300);
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      ipcMain.removeListener('pet:delete-animation-finished', onFinished);
      resolve();
    }
    function onFinished(event) {
      if (event.sender !== petWindow?.webContents) return;
      finish();
    }
    ipcMain.on('pet:delete-animation-finished', onFinished);
    const send = () => {
      if (!finished && petWindow && !petWindow.isDestroyed()) {
        petWindow.webContents.send('pet:delete-animation', asset);
      }
    };
    // A context-menu click can start a second Electron process while the
    // desktop pet is still loading.  Sending before did-finish-load drops the
    // IPC event in some Electron versions, so defer it until the renderer is
    // ready while retaining the timeout fallback.
    if (petWindow.webContents.isLoading()) {
      petWindow.webContents.once('did-finish-load', send);
    } else {
      send();
    }
  });
}

async function moveFileToRecycleBin(target) {
  if (typeof shell.trashItem === 'function') {
    try {
      await shell.trashItem(target);
      return;
    } catch (error) {
      console.warn(`Electron 回收站接口失败，改用 Windows 回收站接口：${error.message}`);
    }
  }
  // Keep a Windows fallback for Electron builds where shell.trashItem is not
  // available or cannot handle a path selected from Explorer.
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic;',
    `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(${quotePowerShell(target)},`,
    '[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,',
    '[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)'
  ].join(' ');
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
}

async function handleFileDeleteRequest(filePath) {
  if (deleteRequestBusy) return;
  deleteRequestBusy = true;
  deleteRequestPath = path.resolve(filePath || '');
  try {
    const target = deleteRequestPath;
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error('右键删除目前只支持文件，不支持文件夹。');
    await runTask(async () => {
      await movePetToDeleteTarget();
      await playDeleteAnimationAndWait(deleteAnimationAsset());
      await moveFileToRecycleBin(target);
    });
  } catch (error) {
    console.error(`通过 listagent 删除文件失败：${error.message}`);
    // Explorer does not expose the Electron console, so an error would look
    // like a dead context-menu item.  Surface the actual reason to the user.
    if (!app.isQuiting) {
      dialog.showErrorBox('通过 listagent 删除失败', error.message || '无法将文件移入回收站。');
    }
  } finally {
    deleteRequestPath = '';
    deleteRequestBusy = false;
  }
}

function greetingCacheKey(settings, surface) {
  return JSON.stringify({
    surface,
    persona: settings.persona,
    textApi: {
      baseUrl: settings.api.textBaseUrl,
      model: settings.api.textModel,
      apiKey: settings.api.textApiKey,
      temperature: settings.api.temperature
    }
  });
}

function invalidateGreetingCache() {
  greetingCache.clear();
}

function getGreeting(settings, surface) {
  const key = greetingCacheKey(settings, surface);
  if (greetingCache.has(key)) return Promise.resolve(greetingCache.get(key));
  if (greetingInFlight.has(key)) return greetingInFlight.get(key);
  const request = generateGreeting(settings, surface)
    .then((greeting) => {
      greetingCache.set(key, greeting);
      return greeting;
    })
    .finally(() => greetingInFlight.delete(key));
  greetingInFlight.set(key, request);
  return request;
}

function warmGreetingCache() {
  const settings = readSettings();
  for (const surface of ['console', 'bubble']) {
    getGreeting(settings, surface).catch(() => {});
  }
}

function syncCompanionUsage() {
  const totals = getModelUsageTotals();
  const delta = {
    promptTokens: Math.max(0, Number(totals.promptTokens) - companionUsageCheckpoint.promptTokens),
    completionTokens: Math.max(0, Number(totals.completionTokens) - companionUsageCheckpoint.completionTokens),
    totalTokens: Math.max(0, Number(totals.totalTokens) - companionUsageCheckpoint.totalTokens),
    estimated: Number(totals.estimatedRequests) > companionUsageCheckpoint.estimatedRequests
  };
  if (delta.totalTokens || delta.promptTokens || delta.completionTokens) recordModelUsage(delta);
  companionUsageCheckpoint = {
    requests: Number(totals.requests) || 0,
    promptTokens: Number(totals.promptTokens) || 0,
    completionTokens: Number(totals.completionTokens) || 0,
    totalTokens: Number(totals.totalTokens) || 0,
    estimatedRequests: Number(totals.estimatedRequests) || 0
  };
}

function broadcastCompanionRecord() {
  syncCompanionUsage();
  const record = getCompanionRecord();
  if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.webContents.send('companion:record-changed', record);
  return record;
}

function startCompanionRecordMonitor() {
  if (companionRecordTimer) return;
  companionRecordTimer = setInterval(() => broadcastCompanionRecord(), 5000);
}

function stopCompanionRecordMonitor() {
  if (companionRecordTimer) clearInterval(companionRecordTimer);
  companionRecordTimer = undefined;
  syncCompanionUsage();
}

function hasTextModelConnection(settings) {
  const api = settings?.api || {};
  return Boolean(String(api.textBaseUrl || api.baseUrl || '').trim()
    && String(api.textApiKey || api.apiKey || '').trim()
    && String(api.textModel || api.model || '').trim());
}

function getWellbeingScene(settings) {
  if (settings?.automation?.wellbeingEnabled === false || !hasTextModelConnection(settings)) return null;
  let idleSeconds = 0;
  try {
    idleSeconds = Number(powerMonitor?.getSystemIdleTime?.()) || 0;
  } catch {
    idleSeconds = 0;
  }
  // A long period with no keyboard/mouse input is a natural break.  Reset the
  // continuous-use clock so the next active session starts fresh.
  if (idleSeconds >= WELLBEING_IDLE_RESET_SECONDS) {
    wellbeingUsageStartedAt = 0;
    return null;
  }
  if (!wellbeingUsageStartedAt) wellbeingUsageStartedAt = Date.now();
  const nowMs = Date.now();
  if (nowMs - wellbeingUsageStartedAt < WELLBEING_START_GRACE_MS && wellbeingLastTriggerAt === 0) return null;
  const minInterval = Math.max(10 * 60 * 1000, Number(settings.automation.wellbeingMinIntervalMs) || 45 * 60 * 1000);
  if (wellbeingLastTriggerAt && nowMs - wellbeingLastTriggerAt < minInterval) return null;
  const activeMs = nowMs - wellbeingUsageStartedAt;
  const now = new Date(nowMs);
  const hour = now.getHours();
  const time = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (hour >= 23 || hour < 7) {
    return { key: 'late-night', title: '夜间休息', context: `现在是 ${time}，时间已经比较晚了。使用者仍在电脑前，请温柔提醒早点休息，明早再继续也不迟。` };
  }
  const longUseThreshold = Math.max(30 * 60 * 1000, Number(settings.automation.wellbeingLongUseThresholdMs) || 90 * 60 * 1000);
  if (activeMs >= longUseThreshold) {
    const minutes = Math.max(1, Math.round(activeMs / 60000));
    return { key: 'long-use', title: '连续使用时间较长', context: `使用者已经连续使用电脑约 ${minutes} 分钟，适合提醒站起来活动一下、看看远处、喝点水，让眼睛和身体休息一会儿。` };
  }
  if ((hour === 12 || hour === 13) && activeMs >= WELLBEING_ACTIVE_MEAL_THRESHOLD_MS) {
    return { key: 'meal', title: '午间补充能量', context: `现在是 ${time} 左右，接近午餐时间。使用者已经使用电脑一段时间，请自然提醒吃饭和补充水分。` };
  }
  if (hour >= 15 && hour < 18 && activeMs >= WELLBEING_ACTIVE_EYE_THRESHOLD_MS) {
    return { key: 'eye-break', title: '眼睛休息', context: `现在是 ${time}，使用者已经盯着屏幕一段时间，请提醒做一次短暂的远眺或眨眼放松。` };
  }
  if (hour >= 20 && hour < 23 && activeMs >= WELLBEING_ACTIVE_EYE_THRESHOLD_MS) {
    return { key: 'evening', title: '晚间放松', context: `现在是 ${time}，已经进入晚间。使用者仍在电脑前，请提醒适度收尾、活动身体并留意休息。` };
  }
  return null;
}

function sendWellbeingMessage(payload) {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  const send = () => {
    if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
    bubbleWindow.webContents.send('agent:wellbeing', payload);
  };
  if (bubbleWindow.webContents.isLoading()) bubbleWindow.webContents.once('did-finish-load', send);
  else send();
}

async function pollWellbeingReminder() {
  if (wellbeingBusy || taskDepth > 0 || (confirmationWindow && confirmationWindow.isVisible()) || (consoleWindow && consoleWindow.isVisible())) return;
  const settings = readSettings();
  const scene = getWellbeingScene(settings);
  if (!scene) return;
  wellbeingBusy = true;
  try {
    const text = await generateWellbeingMessage(settings, scene);
    wellbeingLastTriggerAt = Date.now();
    stopAutoMove();
    const hadBubbleWindow = Boolean(bubbleWindow && !bubbleWindow.isDestroyed());
    const bubbleWasVisible = hadBubbleWindow && bubbleWindow.isVisible();
    if (!bubbleWindow || bubbleWindow.isDestroyed()) createBubbleWindow();
    positionBubbleWindow();
    if (typeof bubbleWindow.showInactive === 'function') bubbleWindow.showInactive();
    else bubbleWindow.show();
    // Do not refresh a currently open conversation: replacing its history
    // while the user is typing would remove transient UI state. A newly
    // created/hidden bubble still receives the normal history before the tip.
    if (!bubbleWasVisible) sendChatHistory(bubbleWindow);
    sendWellbeingMessage({ text, scene: scene.key, timestamp: new Date().toISOString() });
  } catch (error) {
    // A transient provider/network failure should never interrupt the desktop
    // pet or produce a false “reminder sent” message. Suppress immediate
    // retries as well, so an unavailable provider cannot be polled every minute.
    wellbeingLastTriggerAt = Date.now();
    console.warn(`生成人文关怀提醒失败：${error.message}`);
  } finally {
    wellbeingBusy = false;
  }
}

function stopWellbeingMonitor() {
  if (wellbeingTimer) clearInterval(wellbeingTimer);
  wellbeingTimer = undefined;
  wellbeingBusy = false;
  wellbeingUsageStartedAt = Date.now();
}

function syncWellbeingMonitor(config) {
  if (config?.automation?.wellbeingEnabled === false) {
    if (wellbeingTimer) stopWellbeingMonitor();
    return;
  }
  if (wellbeingTimer) return;
  wellbeingTimer = setInterval(() => { void pollWellbeingReminder(); }, WELLBEING_POLL_MS);
}

async function checkForUpdates() {
  return getUpdateInfo(readSettings());
}

function emitUpdateProgress(progress = {}) {
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    consoleWindow.webContents.send('update:progress', progress);
  }
}

async function installAvailableUpdate() {
  const update = await getUpdateInfo(readSettings());
  if (!update.updateAvailable) throw new Error('当前已经是最新版本。');
  emitUpdateProgress({ phase: 'starting', downloaded: 0, total: 0, files: 0, completedFiles: 0 });
  const updatePayload = await downloadUpdate(update, emitUpdateProgress);
  const updater = path.join(PROJECT_ROOT, 'scripts', 'apply-update.ps1');
  if (!fs.existsSync(updater)) throw new Error('更新程序文件缺失。');
  const executablePath = path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const updaterArgs = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', updater,
    '-InstallRoot', PROJECT_ROOT,
    '-ParentPid', String(process.pid),
    '-ExecutablePath', executablePath
  ];
  if (updatePayload.kind === 'delta') updaterArgs.push('-PayloadPath', updatePayload.payloadPath);
  else updaterArgs.push('-ArchivePath', updatePayload.archivePath);
  const child = spawn('powershell.exe', updaterArgs, { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  app.isQuiting = true;
  setTimeout(() => app.quit(), 120);
  return { started: true, version: update.latestVersion, mode: updatePayload.kind, files: updatePayload.files, bytes: updatePayload.bytes };
}

function rendererPath(file) {
  return path.join(PROJECT_ROOT, 'renderer', file);
}

function hasIdlePetAsset() {
  const pet = toPublicSettings(readSettings()).pet;
  return Boolean(pet.idle?.url || pet.standing?.url || (restModeActive && pet.rest?.url));
}

function movementPauseRange(settings = readSettings()) {
  const automation = settings?.automation || {};
  const min = Math.min(MOVE_PAUSE_MAX_MS, Math.max(MOVE_PAUSE_MIN_MS, Math.round(Number(automation.movementPauseMinMs) || 30 * 1000)));
  const max = Math.min(MOVE_PAUSE_MAX_MS, Math.max(MOVE_PAUSE_MIN_MS, Math.round(Number(automation.movementPauseMaxMs) || 90 * 1000)));
  return min <= max ? { min, max } : { min: max, max: min };
}

function restOffsetPx(settings = readSettings()) {
  return Math.min(200, Math.max(0, Math.round(Number(settings?.automation?.restOffsetPx) || 0)));
}

function positionPetAtRestCorner() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const bounds = petWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const offset = restOffsetPx();
  const x = Math.round(area.x + area.width - bounds.width - 12);
  const y = Math.round(area.y + area.height - bounds.height - offset);
  petWindow.setPosition(
    Math.max(area.x, Math.min(x, area.x + area.width - bounds.width)),
    Math.max(area.y, Math.min(y, area.y + area.height - bounds.height))
  );
}

function syncRestMode(config, { forcePosition = false } = {}) {
  const enabled = config?.automation?.restMode === true;
  const changed = enabled !== restModeActive;
  restModeActive = enabled;
  if (enabled) {
    stopAutoMove();
    perchedOnWindow = false;
    perchedWindowInfo = undefined;
    if (changed || forcePosition) {
      positionPetAtRestCorner();
      emitMovementState(false, { perched: false });
    }
  } else if (changed) {
    scheduleRandomMove();
  }
}

function emitMovementState(isMoving, metadata = {}) {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:movement-state', {
      isMoving: Boolean(isMoving),
      perched: metadata.perched === true
    });
  }
}

function canAutoMove() {
  return Boolean(
    petWindow &&
    !petWindow.isDestroyed() &&
    hasIdlePetAsset() &&
    !userDragging &&
    !restModeActive &&
    !autoMoving &&
    taskDepth === 0 &&
    (!consoleWindow || !consoleWindow.isVisible()) &&
    (!bubbleWindow || !bubbleWindow.isVisible()) &&
    (!confirmationWindow || !confirmationWindow.isVisible())
  );
}

function stopAutoMove(metadata = {}) {
  if (randomMoveTimer) clearTimeout(randomMoveTimer);
  if (moveAnimationTimer) clearInterval(moveAnimationTimer);
  randomMoveTimer = undefined;
  moveAnimationTimer = undefined;
  if (autoMoving) emitMovementState(false, metadata);
  autoMoving = false;
}

function scheduleRandomMove() {
  if (randomMoveTimer) clearTimeout(randomMoveTimer);
  randomMoveTimer = undefined;
  if (!canAutoMove()) return;
  const { min, max } = movementPauseRange();
  const delayMs = min + Math.floor(Math.random() * Math.max(0, max - min));
  randomMoveTimer = setTimeout(() => {
    randomMoveTimer = undefined;
    void startRandomMove();
  }, delayMs);
}

function startAutoMoveWatchdog() {
  if (autoMoveWatchdogTimer) return;
  autoMoveWatchdogTimer = setInterval(() => {
    // Keep the in-memory flag aligned with settings even when a settings file
    // was changed by another process or an older renderer.  A stale rest flag
    // would otherwise block every natural-movement attempt until restart.
    const configuredRestMode = readSettings().automation.restMode === true;
    if (configuredRestMode !== restModeActive) {
      syncRestMode(toPublicSettings(readSettings()));
    }
    // A task or an open panel can legitimately pause movement. Once the
    // blocking condition clears, this watchdog recreates a lost timer instead
    // of requiring another UI event to kick the scheduler.
    if (!randomMoveTimer && !autoMoving && !restModeActive) scheduleRandomMove();
  }, AUTO_MOVE_WATCHDOG_MS);
}

function stopAutoMoveWatchdog() {
  if (autoMoveWatchdogTimer) clearInterval(autoMoveWatchdogTimer);
  autoMoveWatchdogTimer = undefined;
}

function chooseFreeDestination(bounds) {
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const minX = workArea.x + 12;
  const maxX = Math.max(minX, workArea.x + workArea.width - bounds.width - 12);
  const minY = workArea.y + 12;
  const maxY = Math.max(minY, workArea.y + workArea.height - bounds.height - 12);
  let destination = { x: bounds.x, y: bounds.y };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    destination = {
      x: Math.round(minX + Math.random() * (maxX - minX)),
      y: Math.round(minY + Math.random() * (maxY - minY))
    };
    if (Math.hypot(destination.x - bounds.x, destination.y - bounds.y) >= 100) break;
  }
  return destination;
}

function choosePerchDestination(bounds, windowInfo, preserveX = false) {
  const windowCenterX = windowInfo.x + windowInfo.width / 2;
  const perchX = preserveX
    ? bounds.x
    : windowCenterX - bounds.width / 2 + (Math.random() - 0.5) * Math.max(0, windowInfo.width - bounds.width);
  // Place the pet's center slightly above the window's upper edge, like it is sitting on it.
  const perchOffset = Number(readSettings().automation.perchOffsetPx) || 0;
  const perchY = windowInfo.y - Math.round(bounds.height * 0.56) + perchOffset;
  const display = screen.getDisplayNearestPoint({ x: Math.round(windowCenterX), y: Math.round(windowInfo.y) });
  const workArea = display.workArea;
  return {
    x: Math.round(Math.max(workArea.x, Math.min(perchX, workArea.x + workArea.width - bounds.width))),
    y: Math.round(Math.max(workArea.y, Math.min(perchY, workArea.y + workArea.height - bounds.height)))
  };
}

async function chooseDestination(bounds) {
  const topmostWindows = await findTopmostUnmaximizedWindows(process.pid);
  if (topmostWindows.length) {
    const targetWindow = topmostWindows[Math.floor(Math.random() * topmostWindows.length)];
    return { position: choosePerchDestination(bounds, targetWindow), perched: true, windowInfo: targetWindow };
  }
  return { position: chooseFreeDestination(bounds), perched: false };
}

async function perchPetOnTopmostWindow() {
  if (!petWindow || petWindow.isDestroyed()) throw new Error('桌宠窗口尚未准备好。');
  stopAutoMove();
  const windows = await findTopmostUnmaximizedWindows(process.pid);
  if (!windows.length) throw new Error('当前没有检测到可坐下的置顶或前台窗口。');
  const target = windows[Math.floor(Math.random() * windows.length)];
  perchedWindowInfo = target;
  perchedOnWindow = true;
  const destination = choosePerchDestination(petWindow.getBounds(), target);
  await movePetLinearly(destination, { perched: true });
  scheduleRandomMove();
  return { ok: true, title: target.title || '置顶窗口' };
}

function repositionPerchedPet() {
  if (!perchedWindowInfo || !petWindow || petWindow.isDestroyed() || userDragging || autoMoving) return;
  const destination = choosePerchDestination(petWindow.getBounds(), perchedWindowInfo, true);
  void movePetLinearly(destination, { perched: true });
}

async function snapPetToNearbyWindow() {
  if (!petWindow || petWindow.isDestroyed()) return false;
  const bounds = petWindow.getBounds();
  const windows = await findTopmostUnmaximizedWindows(process.pid);
  if (userDragging || !petWindow || petWindow.isDestroyed()) return false;
  const petRight = bounds.x + bounds.width;
  const petBottom = bounds.y + bounds.height;
  const candidates = windows
    .map((windowInfo) => {
      const overlap = Math.min(petRight, windowInfo.x + windowInfo.width) - Math.max(bounds.x, windowInfo.x);
      const verticalDistance = Math.abs(petBottom - windowInfo.y);
      return { windowInfo, overlap, verticalDistance };
    })
    .filter(({ overlap, verticalDistance }) => overlap >= PERCH_SNAP_MIN_OVERLAP_DIP && verticalDistance <= PERCH_SNAP_DISTANCE_DIP)
    .sort((a, b) => a.verticalDistance - b.verticalDistance);
  const nearest = candidates[0];
  if (!nearest) return false;
  perchedWindowInfo = nearest.windowInfo;
  perchedOnWindow = true;
  await movePetLinearly(choosePerchDestination(bounds, nearest.windowInfo, true), { perched: true });
  return true;
}

async function startRandomMove() {
  if (!canAutoMove()) return;
  const start = petWindow.getBounds();
  const target = await chooseDestination(start);
  if (!canAutoMove()) return;
  const destination = target.position;
  const distance = Math.hypot(destination.x - start.x, destination.y - start.y);
  recordMovement(distance);
  if (distance < 2) {
    perchedOnWindow = target.perched;
    perchedWindowInfo = target.windowInfo;
    scheduleRandomMove();
    return;
  }
  const startTime = Date.now();
  const duration = (distance / AUTO_MOVE_PIXELS_PER_SECOND) * 1000;
  autoMoving = true;
  emitMovementState(true);

  moveAnimationTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || userDragging || taskDepth > 0 || (consoleWindow && consoleWindow.isVisible())) {
      stopAutoMove({ perched: target.perched });
      scheduleRandomMove();
      return;
    }
    const progress = Math.min(1, (Date.now() - startTime) / duration);
    petWindow.setPosition(
      Math.round(start.x + (destination.x - start.x) * progress),
      Math.round(start.y + (destination.y - start.y) * progress)
    );
    if (progress === 1) {
      perchedOnWindow = target.perched;
      perchedWindowInfo = target.windowInfo;
      stopAutoMove({ perched: target.perched });
      scheduleRandomMove();
    }
  }, 32);
}

function lockPetViewport() {
  if (!petWindow || petWindow.isDestroyed() || lockingPetViewport) return;
  lockingPetViewport = true;
  try {
    const expected = petDimensions();
    petWindow.setMinimumSize(expected.width, expected.height);
    petWindow.setMaximumSize(expected.width, expected.height);
    const [width, height] = petWindow.getContentSize();
    if (width !== expected.width || height !== expected.height) petWindow.setContentSize(expected.width, expected.height);
    if (petWindow.webContents.getZoomFactor() !== 1) petWindow.webContents.setZoomFactor(1);
    Promise.resolve(petWindow.webContents.setVisualZoomLevelLimits(1, 1)).catch(() => {});
  } finally {
    lockingPetViewport = false;
  }
}

function createPetWindow() {
  petWindow = new BrowserWindow({
    width: PET_WIDTH,
    height: PET_HEIGHT,
    useContentSize: true,
    minWidth: PET_WIDTH,
    minHeight: PET_HEIGHT,
    maxWidth: PET_WIDTH,
    maxHeight: PET_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  petWindow.setAlwaysOnTop(true, 'floating');
  petWindow.loadFile(rendererPath('index.html'), { query: { view: 'pet' } });
  petWindow.webContents.once('did-finish-load', () => {
    lockPetViewport();
    if (restModeActive) positionPetAtRestCorner();
    scheduleRandomMove();
  });
  petWindow.webContents.on('zoom-changed', lockPetViewport);
  petWindow.on('resize', lockPetViewport);
  petWindow.on('closed', () => {
    stopAutoMove();
    petWindow = undefined;
  });
}

function createConsoleWindow() {
  consoleWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 760,
    minHeight: 620,
    show: false,
    backgroundColor: '#10131d',
    autoHideMenuBar: true,
    title: 'listagent 控制台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  consoleWindow.loadFile(rendererPath('index.html'), { query: { view: 'console' } });
  consoleWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      consoleWindow.hide();
      scheduleRandomMove();
    }
  });
  consoleWindow.on('closed', () => {
    consoleWindow = undefined;
    scheduleRandomMove();
  });
}

function positionBubbleWindow() {
  if (!bubbleWindow || bubbleWindow.isDestroyed() || !petWindow || petWindow.isDestroyed()) return;
  const pet = petWindow.getBounds();
  const [width, height] = bubbleWindow.getSize();
  const display = screen.getDisplayNearestPoint({ x: pet.x, y: pet.y });
  const area = display.workArea;
  let x = pet.x + pet.width + 10;
  if (x + width > area.x + area.width) x = pet.x - width - 10;
  let y = pet.y + 12;
  y = Math.max(area.y, Math.min(y, area.y + area.height - height));
  bubbleWindow.setPosition(Math.round(x), Math.round(y));
}

function sendChatHistory(window) {
  if (!window || window.isDestroyed()) return;
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send('agent:history-changed', getSessionHistory());
  };
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', send);
  else send();
}

function createBubbleWindow() {
  bubbleWindow = new BrowserWindow({
    width: 380,
    height: 330,
    show: false,
    minWidth: 320,
    minHeight: 260,
    maxWidth: 520,
    maxHeight: 500,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // The panel owns its own soft elevation; disable the native opaque shadow.
    hasShadow: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  // Some Windows builds ignore the constructor flag for transparent windows;
  // enforce it after creation so rounded corners cannot receive a native black shadow.
  bubbleWindow.setHasShadow(false);
  bubbleWindow.setAlwaysOnTop(true, 'floating');
  bubbleWindow.loadFile(rendererPath('index.html'), { query: { view: 'bubble' } });
  bubbleWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      bubbleWindow.hide();
      scheduleRandomMove();
    }
  });
  bubbleWindow.on('closed', () => {
    bubbleWindow = undefined;
    scheduleRandomMove();
  });
}

function openBubbleChat() {
  stopAutoMove();
  if (!bubbleWindow) createBubbleWindow();
  positionBubbleWindow();
  bubbleWindow.show();
  bubbleWindow.focus();
  sendChatHistory(bubbleWindow);
}

function closeBubbleChat() {
  bubbleWindow?.hide();
  scheduleRandomMove();
}

function createConfirmationWindow() {
  confirmationWindow = new BrowserWindow({
    width: 480,
    height: 360,
    minWidth: 400,
    minHeight: 300,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#181b2a',
    title: 'listagent 操作确认',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  confirmationWindow.setAlwaysOnTop(true, 'floating');
  confirmationWindow.loadFile(rendererPath('index.html'), { query: { view: 'confirmation' } });
  confirmationWindow.webContents.once('did-finish-load', () => {
    confirmationWindow?.webContents.send('agent:confirmation', pendingConfirmationPayload);
  });
  confirmationWindow.on('closed', () => {
    confirmationWindow = undefined;
    pendingConfirmationPayload = [];
  });
}

function openConfirmationWindow(actions) {
  const nextActions = Array.isArray(actions) ? actions.filter((action) => action?.id) : [];
  if (!nextActions.length) return;
  pendingConfirmationPayload = nextActions;
  if (!confirmationWindow) createConfirmationWindow();
  if (!confirmationWindow.webContents.isLoading()) {
    confirmationWindow.webContents.send('agent:confirmation', pendingConfirmationPayload);
  }
  confirmationWindow.show();
  confirmationWindow.focus();
}

function closeConfirmationWindow() {
  confirmationWindow?.hide();
  scheduleRandomMove();
}

function createWechatDebugWindow() {
  wechatDebugWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 540,
    show: false,
    backgroundColor: '#10131d',
    autoHideMenuBar: true,
    title: '微信识图调试 · listagent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  wechatDebugWindow.loadFile(rendererPath('wechat-debug.html'));
  wechatDebugWindow.webContents.once('did-finish-load', () => {
    if (wechatDebugWindow && !wechatDebugWindow.isDestroyed()) {
      wechatDebugWindow.webContents.send('wechat:debug-event', lastWechatDebug);
    }
  });
  wechatDebugWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      wechatDebugWindow.hide();
    }
  });
  wechatDebugWindow.on('closed', () => {
    wechatDebugWindow = undefined;
  });
}

function openWechatDebug() {
  if (!wechatDebugWindow) createWechatDebugWindow();
  wechatDebugWindow.show();
  wechatDebugWindow.focus();
  if (wechatDebugWindow.webContents.isLoading() === false) {
    wechatDebugWindow.webContents.send('wechat:debug-event', lastWechatDebug);
  }
}

function emitWechatDebug(update = {}) {
  lastWechatDebug = {
    ...lastWechatDebug,
    ...update,
    timestamp: new Date().toISOString()
  };
  if (wechatDebugWindow && !wechatDebugWindow.isDestroyed() && !wechatDebugWindow.webContents.isLoading()) {
    wechatDebugWindow.webContents.send('wechat:debug-event', lastWechatDebug);
  }
}

function saveWechatDebugImage() {
  const prefix = 'data:image/png;base64,';
  if (!lastWechatDebug.imageDataUrl?.startsWith(prefix)) {
    throw new Error('当前还没有可保存的微信截图，请先执行一次截图。');
  }
  const directory = path.join(PROJECT_ROOT, 'data', 'debug-captures');
  fs.mkdirSync(directory, { recursive: true });
  const filename = `wechat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  const target = path.join(directory, filename);
  fs.writeFileSync(target, Buffer.from(lastWechatDebug.imageDataUrl.slice(prefix.length), 'base64'));
  emitWechatDebug({ message: `截图已保存到调试目录：${target}` });
  return { ok: true, path: target };
}

async function captureWechatForDebug() {
  const settings = readSettings();
  let capture;
  try {
    capture = await captureWeChatWindow();
    emitWechatDebug({
      state: 'captured',
      message: '已直接截取微信窗口原始 PNG；正在尝试 YOLO / 视觉识别（不会影响截图）。',
      sender: 'unknown',
      senderReason: '',
      recognizedText: '',
      raw: '',
      captureMethod: capture.captureMethod || '',
      captureWidth: capture.width || 0,
      captureHeight: capture.height || 0,
      imageDataUrl: `data:image/png;base64,${capture.base64}`
    });
    try {
      const yoloDetection = await detectWeChatBubble(capture.path);
      const observation = await analyzeWechatImage(settings, capture.base64, yoloDetection);
      emitWechatDebug({
        state: 'inspected',
        message: '手动识图完成；本次不会发送微信消息。',
        sender: observation.sender,
        senderReason: observation.senderReason || '',
        recognizedText: observation.text,
        raw: observation.raw,
        captureMethod: capture.captureMethod || '',
        captureWidth: capture.width || 0,
        captureHeight: capture.height || 0,
        imageDataUrl: `data:image/png;base64,${capture.base64}`
      });
    } catch (error) {
      emitWechatDebug({
        state: 'captured',
        message: `截图已完成，但本次未执行识图：${error.message}`,
        sender: 'unknown',
        senderReason: '截图与识图已解耦；请配置视觉模型后再识别。',
        recognizedText: '',
        raw: error.stack || error.message,
        captureMethod: capture.captureMethod || '',
        captureWidth: capture.width || 0,
        captureHeight: capture.height || 0,
        imageDataUrl: `data:image/png;base64,${capture.base64}`
      });
    }
    return lastWechatDebug;
  } catch (error) {
    emitWechatDebug({ state: 'error', message: `手动识图失败：${error.message}`, raw: error.stack || error.message });
    throw error;
  } finally {
    if (capture?.path) {
      try { fs.unlinkSync(capture.path); } catch { /* best-effort privacy cleanup */ }
    }
  }
}

function openConsole() {
  stopAutoMove();
  bubbleWindow?.hide();
  if (!consoleWindow) createConsoleWindow();
  consoleWindow.show();
  consoleWindow.focus();
  sendChatHistory(consoleWindow);
  broadcastCompanionRecord();
}

function broadcastConfig(patch = {}) {
  const config = toPublicSettings(readSettings());
  invalidateGreetingCache();
  for (const window of [petWindow, consoleWindow, bubbleWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('config:changed', config);
  }
  warmGreetingCache();
  syncWechatMonitor(config);
  syncWellbeingMonitor(config);
  syncRestMode(config, {
    forcePosition: Boolean(patch?.automation && (
      Object.prototype.hasOwnProperty.call(patch.automation, 'restOffsetPx')
      || Object.prototype.hasOwnProperty.call(patch.automation, 'restMode')
    ))
  });
  scheduleRandomMove();
  return config;
}

function emitWechatMonitor(event) {
  if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.webContents.send('wechat:monitor-event', event);
}

function stopWechatMonitor() {
  if (wechatMonitorTimer) clearInterval(wechatMonitorTimer);
  wechatMonitorTimer = undefined;
  wechatMonitorIntervalMs = 0;
  wechatMonitorBusy = false;
  wechatLastCaptureHash = '';
  wechatLastRepliedMessageKey = '';
  emitWechatMonitor({ state: 'stopped', message: '微信监听已停止。' });
}

function wechatMessageKey(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[，。！？、,.!?：:；;“”"'‘’（）()【】\[\]{}]/g, '').slice(0, 4000);
}

async function pollWechatMonitor() {
  if (wechatMonitorBusy) return;
  const settings = readSettings();
  if (!settings.automation.enabled || !settings.automation.wechatMonitorEnabled) return;
  wechatMonitorBusy = true;
  let capture;
  try {
    capture = await captureWeChatWindow();
    if (!wechatLastCaptureHash) {
      wechatLastCaptureHash = capture.hash;
      emitWechatDebug({
        state: 'baseline',
        message: '已建立微信画面基线，本次不会回复。',
        sender: 'unknown',
        senderReason: '',
        recognizedText: '',
        raw: '',
        captureMethod: capture.captureMethod || '',
        captureWidth: capture.width || 0,
        captureHeight: capture.height || 0,
        imageDataUrl: `data:image/png;base64,${capture.base64}`
      });
      emitWechatMonitor({ state: 'ready', message: '已建立微信画面基线，等待新消息。' });
      return;
    }
    if (capture.hash === wechatLastCaptureHash) return;
    wechatLastCaptureHash = capture.hash;
    emitWechatDebug({
      state: 'captured',
      message: '已截取微信窗口，正在判断是否有新消息。',
      sender: 'unknown',
      senderReason: '',
      recognizedText: '',
      raw: '',
      captureMethod: capture.captureMethod || '',
      captureWidth: capture.width || 0,
      captureHeight: capture.height || 0,
      imageDataUrl: `data:image/png;base64,${capture.base64}`
    });
    emitWechatMonitor({ state: 'changed', message: '检测到微信画面变化，正在判断是否有新消息。' });
    if (!settings.automation.wechatAutoReply || !settings.automation.autoExecute) {
      emitWechatMonitor({ state: 'changed', message: '检测到画面变化；自动回复未开启，未发送消息。' });
      return;
    }
    const yoloDetection = await detectWeChatBubble(capture.path);
    const answer = await chatWithWechatImage(settings, capture.base64, yoloDetection);
    emitWechatDebug({
      state: answer.reply ? 'replied' : 'skipped',
      message: answer.reply ? '已识别对方消息并生成回复。' : (answer.sender === 'self' ? '最后一条消息由自己发送，已跳过回复。' : '未确认最后一条消息来自对方，已跳过回复。'),
      sender: answer.sender || 'unknown',
      senderReason: answer.senderReason || '',
      recognizedText: answer.recognizedText || '',
      raw: answer.visionRaw || ''
    });
    if (!answer.reply) {
      const message = answer.sender === 'self'
        ? '最新一条微信消息由自己发送，已跳过自动回复。'
        : answer.sender === 'unknown'
          ? '无法确认最新微信消息的发送者，已跳过自动回复。'
          : '未识别到需要回复的新消息。';
      emitWechatMonitor({ state: 'idle', message });
      return;
    }
    const messageKey = wechatMessageKey(answer.recognizedText);
    if (!messageKey || messageKey === wechatLastRepliedMessageKey) {
      emitWechatDebug({ state: 'skipped', message: '该消息文字已处理过，已跳过重复回复。' });
      emitWechatMonitor({ state: 'idle', message: '该微信消息已处理过，已跳过重复回复。' });
      return;
    }
    await sendTextToActiveWeChat(answer.reply, true);
    recordConversation();
    broadcastCompanionRecord();
    wechatLastRepliedMessageKey = messageKey;
    emitWechatMonitor({ state: 'replied', message: `已自动回复微信消息：${answer.reply.slice(0, 120)}` });
  } catch (error) {
    emitWechatDebug({
      state: 'error',
      message: `识图或回复失败：${error.message}`,
      raw: error.stack || error.message
    });
    emitWechatMonitor({ state: 'error', message: `微信监听失败：${error.message}` });
  } finally {
    if (capture?.path) {
      try { fs.unlinkSync(capture.path); } catch { /* best-effort privacy cleanup */ }
    }
    wechatMonitorBusy = false;
  }
}

function startWechatMonitor() {
  if (wechatMonitorTimer) return;
  const settings = readSettings();
  if (!settings.automation.enabled || !settings.automation.wechatMonitorEnabled) return;
  const interval = Math.min(30000, Math.max(3000, Number(settings.automation.wechatIntervalMs) || 5000));
  wechatMonitorIntervalMs = interval;
  emitWechatMonitor({ state: 'starting', message: `微信监听已启动，每 ${Math.round(interval / 1000)} 秒检查一次。` });
  void pollWechatMonitor();
  wechatMonitorTimer = setInterval(() => { void pollWechatMonitor(); }, interval);
}

function syncWechatMonitor(config) {
  if (config?.automation?.enabled && config.automation.wechatMonitorEnabled) {
    const desiredInterval = Math.min(30000, Math.max(3000, Number(config.automation.wechatIntervalMs) || 5000));
    if (wechatMonitorTimer && desiredInterval !== wechatMonitorIntervalMs) stopWechatMonitor();
    startWechatMonitor();
  }
  else if (wechatMonitorTimer) stopWechatMonitor();
}

async function runTask(task) {
  taskDepth += 1;
  stopAutoMove();
  try {
    return await task();
  } finally {
    taskDepth -= 1;
    scheduleRandomMove();
  }
}

function positionPet(x, y) {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return;
  const point = { x: Math.round(Number(x)), y: Math.round(Number(y)) };
  const workArea = screen.getDisplayNearestPoint(point).workArea;
  const [width, height] = petWindow.getSize();
  const safeX = Math.max(workArea.x, Math.min(point.x, workArea.x + workArea.width - width));
  const safeY = Math.max(workArea.y, Math.min(point.y, workArea.y + workArea.height - height));
  petWindow.setPosition(safeX, safeY);
}

function readPersonaTextFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('人格附件必须是小于 1MB 的 TXT 文件。');
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('选择的文本文件为空。');
  return text.slice(0, 50000);
}

function registerIpc() {
  ipcMain.handle('config:get', () => toPublicSettings(readSettings()));
  ipcMain.handle('config:save', (_event, patch) => {
    saveSettings(patch);
    if (patch?.automation && Object.prototype.hasOwnProperty.call(patch.automation, 'startAtLogin')) {
      syncLoginItemSettings(patch.automation.startAtLogin);
    }
    const config = broadcastConfig(patch);
    if (patch?.automation && Object.prototype.hasOwnProperty.call(patch.automation, 'perchOffsetPx')) {
      repositionPerchedPet();
    }
    return config;
  });
  ipcMain.handle('update:check', () => checkForUpdates());
  ipcMain.handle('update:install', () => installAvailableUpdate());
  ipcMain.handle('pet:choose-media', async (_event, state) => {
    const targetState = ['idle', 'standing', 'interaction', 'moving', 'rest', 'delete'].includes(state) ? state : 'idle';
    const title = targetState === 'moving'
      ? '选择移动时桌宠动图'
      : targetState === 'standing'
        ? '选择站立时桌宠动图'
        : targetState === 'interaction'
          ? '选择互动时桌宠动图'
          : targetState === 'rest'
            ? '选择休息时桌宠动图'
          : targetState === 'delete'
            ? '选择文件删除时播放的动图'
            : '选择坐立时桌宠动图';
    const answer = await dialog.showOpenDialog({
      title,
      properties: ['openFile'],
      filters: [{ name: 'GIF 或 WebM 动图', extensions: ['gif', 'webm'] }]
    });
    if (answer.canceled || !answer.filePaths[0]) return toPublicSettings(readSettings());
    importPetAsset(answer.filePaths[0], targetState);
    return broadcastConfig();
  });
  ipcMain.handle('persona:import-text', async (_event, field) => {
    const personaField = field === 'description' || field === 'examples' ? field : '';
    if (!personaField) throw new Error('未知的人格附件类型。');
    const answer = await dialog.showOpenDialog({
      title: personaField === 'description' ? '导入人格设定 TXT' : '导入语言示例 TXT',
      properties: ['openFile'],
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    });
    if (answer.canceled || !answer.filePaths[0]) return { config: toPublicSettings(readSettings()), imported: false };
    saveSettings({ persona: { [personaField]: readPersonaTextFile(answer.filePaths[0]) } });
    return { config: broadcastConfig(), imported: true };
  });
  ipcMain.handle('persona:choose-avatar', async () => {
    const answer = await dialog.showOpenDialog({
      title: '选择聊天头像',
      properties: ['openFile'],
      filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    });
    if (answer.canceled || !answer.filePaths[0]) return toPublicSettings(readSettings());
    importPersonaAvatar(answer.filePaths[0]);
    return broadcastConfig();
  });
  ipcMain.handle('pet:drag-start', () => {
    stopAutoMove();
    dragOriginPerchedWindowInfo = perchedOnWindow ? perchedWindowInfo : undefined;
    perchedOnWindow = false;
    perchedWindowInfo = undefined;
    userDragging = true;
    emitMovementState(true);
    return petWindow?.getBounds() || { x: 0, y: 0 };
  });
  ipcMain.on('pet:drag-move', (_event, x, y) => {
    if (!userDragging || !petWindow || petWindow.isDestroyed()) return;
    const before = petWindow.getBounds();
    positionPet(x, y);
    const after = petWindow.getBounds();
    recordMovement(Math.hypot(after.x - before.x, after.y - before.y), { count: false });
  });
  ipcMain.handle('pet:drag-end', async (_event, moved) => {
    userDragging = false;
    const restorePerch = moved !== true && dragOriginPerchedWindowInfo;
    dragOriginPerchedWindowInfo = undefined;
    perchedOnWindow = Boolean(restorePerch);
    perchedWindowInfo = restorePerch || undefined;
    emitMovementState(false, { perched: Boolean(restorePerch) });
    if (moved === true) await snapPetToNearbyWindow();
    scheduleRandomMove();
  });
  ipcMain.handle('pet:perch', () => runTask(() => perchPetOnTopmostWindow()));
  ipcMain.on('pet:scale', (_event, scale) => resizePetWindow(scale));
  ipcMain.handle('agent:chat', (_event, text) => runTask(async () => {
    const answer = await chat(readSettings(), text);
    recordConversation();
    broadcastCompanionRecord();
    if (answer.actions?.length) openConfirmationWindow(answer.actions);
    return answer;
  }));
  ipcMain.handle('agent:greeting', async (_event, surface) => {
    const greeting = await getGreeting(readSettings(), surface === 'bubble' ? 'bubble' : 'console');
    recordGreeting(greeting);
    return greeting;
  });
  ipcMain.handle('agent:history', () => getSessionHistory());
  ipcMain.handle('companion:record', () => broadcastCompanionRecord());
  ipcMain.handle('agent:record-greeting', (_event, greeting) => {
    const history = recordGreeting(greeting);
    sendChatHistory(consoleWindow);
    sendChatHistory(bubbleWindow);
    return history;
  });
  ipcMain.handle('agent:decide-action', (_event, actionId, approved) => runTask(async () => {
    const answer = await decideAction(readSettings(), actionId, approved === true);
    if (answer.actions?.length) openConfirmationWindow(answer.actions);
    return answer;
  }));
  ipcMain.handle('agent:clear', () => {
    clearSession();
    return { ok: true };
  });
  ipcMain.handle('wechat:status', () => runTask(() => getWeChatStatus()));
  ipcMain.handle('wechat:monitor-start', () => {
    if (!readSettings().automation.enabled) throw new Error('请先开启“允许智能体执行电脑操作”。');
    saveSettings({ automation: { wechatMonitorEnabled: true } });
    const config = broadcastConfig();
    return config;
  });
  ipcMain.handle('wechat:monitor-stop', () => {
    saveSettings({ automation: { wechatMonitorEnabled: false } });
    const config = broadcastConfig();
    return config;
  });
  ipcMain.handle('wechat:debug-state', () => lastWechatDebug);
  ipcMain.handle('wechat:debug-capture', () => runTask(() => captureWechatForDebug()));
  ipcMain.handle('wechat:debug-save-image', () => saveWechatDebugImage());
  ipcMain.handle('window:open-wechat-debug', () => openWechatDebug());
  ipcMain.handle('window:open-console', () => openConsole());
  ipcMain.handle('window:open-bubble-chat', () => openBubbleChat());
  ipcMain.handle('window:close-bubble-chat', () => closeBubbleChat());
  ipcMain.handle('window:close-confirmation', () => closeConfirmationWindow());
  ipcMain.handle('window:close-console', () => {
    consoleWindow?.hide();
    scheduleRandomMove();
  });
  ipcMain.handle('app:quit', () => {
    app.isQuiting = true;
    app.quit();
  });
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  ensureDataDirectories();
  registerIpc();
  registerWindowsContextMenu().catch((error) => {
    console.error(`注册资源管理器右键菜单失败：${error.message}`);
  });
  restModeActive = readSettings().automation.restMode === true;
  syncLoginItemSettings(readSettings().automation.startAtLogin === true);
  startSession();
  startAutoMoveWatchdog();
  startCompanionRecordMonitor();
  // Start both greeting requests before either chat surface is opened. The
  // renderer then consumes the shared in-flight request or its cached result.
  warmGreetingCache();
  createPetWindow();
  createConsoleWindow();
  syncWechatMonitor(toPublicSettings(readSettings()));
  syncWellbeingMonitor(toPublicSettings(readSettings()));
  const deleteTarget = deleteTargetFromArgv();
  if (deleteTarget) setTimeout(() => { void handleFileDeleteRequest(deleteTarget); }, 450);
  app.on('activate', openConsole);
});

app.on('window-all-closed', (event) => {
  // The desktop pet is the primary interaction surface; quitting is explicit.
  event.preventDefault();
});

app.on('before-quit', () => {
  if (!hasSingleInstanceLock) return;
  app.isQuiting = true;
  // The user requested a fresh conversation after every complete app exit.
  // Clear both the in-memory session and data/conversation-history.json before
  // Electron closes, while hiding individual windows remains non-destructive.
  clearSession();
  stopAutoMove();
  stopAutoMoveWatchdog();
  stopWechatMonitor();
  stopWellbeingMonitor();
  stopCompanionRecordMonitor();
  finishSession();
  stopWorker();
});
