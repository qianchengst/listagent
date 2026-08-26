const path = require('node:path');
const { spawn } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PYTHON_PATH = path.join(PROJECT_ROOT, '.venv-yolo', 'Scripts', 'python.exe');
const WORKER_PATH = path.join(PROJECT_ROOT, 'yolo', 'worker.py');
const MODEL_PATH = path.join(PROJECT_ROOT, 'models', 'wechat-bubbles.pt');

let worker;
let workerBuffer = '';
let workerReady;
let pendingRequest;
let detectionQueue = Promise.resolve();

function parseJsonLine(line) {
  try {
    const value = JSON.parse(line.trim());
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function stopWorker() {
  if (worker && !worker.killed) worker.kill();
  worker = undefined;
  workerBuffer = '';
  if (workerReady?.reject) workerReady.reject(new Error('YOLO worker 已停止。'));
  if (pendingRequest?.reject) pendingRequest.reject(new Error('YOLO worker 已停止。'));
  workerReady = undefined;
  pendingRequest = undefined;
}

function startWorker() {
  if (worker && !worker.killed) return workerReady.promise;
  worker = spawn(PYTHON_PATH, [WORKER_PATH, '--model', MODEL_PATH], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  workerReady = {};
  workerReady.promise = new Promise((resolve, reject) => {
    workerReady.resolve = resolve;
    workerReady.reject = reject;
  });
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data', (chunk) => {
    workerBuffer += chunk;
    const lines = workerBuffer.split(/\r?\n/);
    workerBuffer = lines.pop() || '';
    for (const line of lines) {
      const message = parseJsonLine(line);
      if (!message) continue;
      if (Object.prototype.hasOwnProperty.call(message, 'ready')) {
        if (message.ready) workerReady.resolve();
        else workerReady.reject(new Error(message.error || 'YOLO 模型加载失败。'));
        continue;
      }
      if (pendingRequest) {
        const request = pendingRequest;
        pendingRequest = undefined;
        request.resolve(message);
      }
    }
  });
  worker.on('error', (error) => {
    workerReady?.reject(error);
    pendingRequest?.reject(error);
    stopWorker();
  });
  worker.on('exit', (code) => {
    if (code !== 0) {
      const error = new Error(`YOLO worker 退出（${code}）。`);
      workerReady?.reject(error);
      pendingRequest?.reject(error);
    }
    worker = undefined;
  });
  return workerReady.promise;
}

async function detectWeChatBubbleInternal(imagePath) {
  if (!imagePath) return { available: false, error: '截图路径为空。' };
  const fs = require('node:fs');
  if (!fs.existsSync(PYTHON_PATH)) return { available: false, error: '本地微信气泡检测组件未安装，自动微信监听暂不可用。' };
  if (!fs.existsSync(MODEL_PATH)) return { available: false, error: '未找到本地微信气泡检测模型，自动微信监听暂不可用。' };
  if (!fs.existsSync(imagePath)) return { available: false, error: '截图文件不存在。' };
  try {
    await startWorker();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequest = undefined;
        reject(new Error('YOLO 推理超时。'));
      }, 30000);
      pendingRequest = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      };
      worker.stdin.write(`${JSON.stringify({ image: imagePath, confidence: 0.45, imgsz: 960 })}\n`);
    });
    return result;
  } catch (error) {
    stopWorker();
    return { available: false, error: error.message };
  }
}

// The worker has one stdin/stdout request slot. Serialize manual debug captures
// and background polling so one request cannot replace another's response.
function detectWeChatBubble(imagePath) {
  const task = detectionQueue.then(() => detectWeChatBubbleInternal(imagePath));
  detectionQueue = task.catch(() => undefined);
  return task;
}

module.exports = { detectWeChatBubble, stopWorker, MODEL_PATH, PYTHON_PATH };
