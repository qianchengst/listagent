const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT, ensureDataDirectories } = require('./settings-service');

const RECORD_PATH = path.join(PROJECT_ROOT, 'data', 'companion-record.json');
const DEFAULT_RECORD = Object.freeze({
  schema: 1,
  totalSessions: 0,
  totalActiveMs: 0,
  totalMovementPx: 0,
  totalMovementCount: 0,
  totalConversations: 0,
  totalTokens: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  estimatedTokenRequests: 0,
  lastStartedAt: '',
  lastUpdatedAt: ''
});

let record;
let sessionStartedAt = 0;

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_RECORD));
}

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeRecord(value) {
  const source = value && typeof value === 'object' ? value : {};
  const next = cloneDefaults();
  for (const key of Object.keys(next)) {
    if (key === 'schema' || key.endsWith('At')) continue;
    next[key] = numberOr(source[key], next[key]);
  }
  next.schema = 1;
  next.lastStartedAt = typeof source.lastStartedAt === 'string' ? source.lastStartedAt : '';
  next.lastUpdatedAt = typeof source.lastUpdatedAt === 'string' ? source.lastUpdatedAt : '';
  return next;
}

function loadRecord() {
  if (record) return record;
  ensureDataDirectories();
  try {
    record = normalizeRecord(JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8')));
  } catch {
    record = cloneDefaults();
  }
  return record;
}

function persist() {
  const current = loadRecord();
  current.lastUpdatedAt = new Date().toISOString();
  try {
    ensureDataDirectories();
    const tempPath = `${RECORD_PATH}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, RECORD_PATH);
  } catch {
    // Metrics are best effort; an unwritable data directory must not interrupt
    // the desktop pet or a conversation.
  }
}

function startSession(now = Date.now()) {
  loadRecord();
  sessionStartedAt = Number(now) || Date.now();
  record.totalSessions += 1;
  record.lastStartedAt = new Date(sessionStartedAt).toISOString();
  persist();
}

function finishSession(now = Date.now()) {
  if (!sessionStartedAt) return;
  const endedAt = Number(now) || Date.now();
  loadRecord();
  record.totalActiveMs += Math.max(0, endedAt - sessionStartedAt);
  sessionStartedAt = 0;
  persist();
}

function recordMovement(distancePx, options = {}) {
  const distance = numberOr(distancePx);
  if (distance < 0.5) return;
  loadRecord();
  record.totalMovementPx += distance;
  // Pointer-move events can arrive many times during one manual drag. Keep
  // the legacy counter for automatic/perch moves, but never inflate it with
  // those high-frequency drag samples.
  if (options.count !== false) record.totalMovementCount += 1;
  persist();
}

function normalizeUsage(usage = {}) {
  const promptTokens = numberOr(usage.prompt_tokens ?? usage.promptTokens);
  const completionTokens = numberOr(usage.completion_tokens ?? usage.completionTokens);
  const totalCandidate = numberOr(usage.total_tokens ?? usage.totalTokens);
  const totalTokens = totalCandidate || promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    estimated: usage.estimated === true
  };
}

function recordModelUsage(usage = {}) {
  const normalized = normalizeUsage(usage);
  if (!normalized.totalTokens && !normalized.promptTokens && !normalized.completionTokens) return;
  loadRecord();
  record.totalPromptTokens += normalized.promptTokens;
  record.totalCompletionTokens += normalized.completionTokens;
  record.totalTokens += normalized.totalTokens;
  if (normalized.estimated) record.estimatedTokenRequests += 1;
  persist();
}

function recordConversation() {
  loadRecord();
  record.totalConversations += 1;
  persist();
}

function getRecord(now = Date.now()) {
  loadRecord();
  const currentSessionMs = sessionStartedAt ? Math.max(0, (Number(now) || Date.now()) - sessionStartedAt) : 0;
  return {
    ...record,
    currentSessionMs,
    activeMs: record.totalActiveMs + currentSessionMs,
    sessionStartedAt: sessionStartedAt ? new Date(sessionStartedAt).toISOString() : '',
    updatedAt: record.lastUpdatedAt || new Date().toISOString()
  };
}

module.exports = {
  RECORD_PATH,
  startSession,
  finishSession,
  recordMovement,
  recordModelUsage,
  recordConversation,
  getRecord
};
