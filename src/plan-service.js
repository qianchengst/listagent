const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR, ensureDataDirectories } = require('./settings-service');

const PLANS_PATH = path.join(DATA_DIR, 'plans.json');
const DAY_ROLLOVER_HOUR = 4;
const REMINDER_WINDOW_MS = 15 * 60 * 1000;

const DEFAULT_PLANS = Object.freeze({
  version: 1,
  today: { bucketDate: '', items: [] },
  todayArchive: [],
  weekly: { stepMinutes: 45, durationMinutes: 45, rowCount: 13, rowTimes: [], slots: [] },
  events: [],
  eventArchive: [],
  todoReminderTimes: ['09:00', '14:00', '19:00'],
  reminderState: {}
});

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_PLANS));
}

function localDateKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateFromKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function effectiveDateKey(date = new Date()) {
  const value = date instanceof Date ? new Date(date) : new Date(date);
  if (Number.isNaN(value.getTime())) return localDateKey();
  if (value.getHours() < DAY_ROLLOVER_HOUR) value.setDate(value.getDate() - 1);
  return localDateKey(value);
}

function normalizeTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeDuration(value, fallback = 45) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(240, Math.max(5, number)) : fallback;
}

function normalizeRowCount(value, fallback = 13) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(40, Math.max(1, number)) : fallback;
}

function defaultRowTimes(rowCount, durationMinutes) {
  const count = normalizeRowCount(rowCount);
  const duration = normalizeDuration(durationMinutes);
  return Array.from({ length: count }, (_item, index) => {
    const total = 8 * 60 + index * duration;
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  });
}

function normalizeRowTimes(values, rowCount, durationMinutes) {
  const count = normalizeRowCount(rowCount);
  const defaults = defaultRowTimes(count, durationMinutes);
  if (!Array.isArray(values)) return defaults;
  return Array.from({ length: count }, (_item, index) => {
    const value = normalizeTime(values[index]);
    return value || defaults[index];
  });
}

function normalizeDateTime(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  // datetime-local values are deliberately retained without a timezone so
  // they continue to represent the user's local Windows time.
  return text.slice(0, 16);
}

function normalizeTodayItem(item = {}) {
  const title = String(item.title || '').trim().slice(0, 200);
  if (!title) return null;
  const allDay = item.allDay === true || (!normalizeTime(item.startTime) && !normalizeTime(item.endTime));
  return {
    id: String(item.id || crypto.randomUUID()),
    title,
    startTime: allDay ? '' : normalizeTime(item.startTime),
    endTime: allDay ? '' : normalizeTime(item.endTime),
    allDay,
    done: item.done === true,
    createdAt: String(item.createdAt || new Date().toISOString()),
    updatedAt: String(item.updatedAt || item.createdAt || new Date().toISOString())
  };
}

function normalizeWeeklySlot(slot = {}) {
  const day = Math.max(0, Math.min(6, Math.round(Number(slot.day)) || 0));
  const start = normalizeTime(slot.start);
  const end = normalizeTime(slot.end);
  // `title` is kept as a compatibility alias for plans created before the
  // event/location split. New entries expose both fields independently.
  const event = String(slot.event ?? slot.title ?? '').trim().slice(0, 200);
  const location = String(slot.location || '').trim().slice(0, 200);
  const title = event || location;
  if (!start || !end || !title) return null;
  return {
    id: String(slot.id || `${day}-${start}`),
    day,
    start,
    end,
    title,
    event,
    location,
    reminderTimes: normalizeReminderTimes(slot.reminderTimes, 3),
    updatedAt: String(slot.updatedAt || new Date().toISOString())
  };
}

function normalizeEvent(event = {}) {
  const title = String(event.title || '').trim().slice(0, 200);
  const startAt = normalizeDateTime(event.startAt);
  if (!title || !startAt) return null;
  const endAt = normalizeDateTime(event.endAt);
  return {
    id: String(event.id || crypto.randomUUID()),
    title,
    startAt,
    endAt: endAt || '',
    done: event.done === true,
    createdAt: String(event.createdAt || new Date().toISOString()),
    updatedAt: String(event.updatedAt || event.createdAt || new Date().toISOString())
  };
}

function normalizeReminderTimes(values, limit = Number.POSITIVE_INFINITY) {
  const list = Array.isArray(values) ? values : [];
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Math.round(Number(limit))) : Number.POSITIVE_INFINITY;
  return [...new Set(list.map(normalizeTime).filter(Boolean))].sort().slice(0, max);
}

function normalizeStore(saved = {}) {
  const result = cloneDefault();
  const today = saved.today && typeof saved.today === 'object' ? saved.today : {};
  result.today.bucketDate = /^\d{4}-\d{2}-\d{2}$/.test(today.bucketDate || '') ? today.bucketDate : '';
  result.today.items = (Array.isArray(today.items) ? today.items : []).map(normalizeTodayItem).filter(Boolean);
  result.todayArchive = Array.isArray(saved.todayArchive)
    ? saved.todayArchive.filter((item) => item && /^\d{4}-\d{2}-\d{2}$/.test(item.date || '')).slice(-120)
    : [];
  const weekly = saved.weekly && typeof saved.weekly === 'object' ? saved.weekly : {};
  const legacyStep = Number(weekly.stepMinutes);
  const duration = normalizeDuration(weekly.durationMinutes ?? (Number.isFinite(legacyStep) ? legacyStep : 45));
  result.weekly.durationMinutes = duration;
  result.weekly.stepMinutes = duration;
  result.weekly.rowCount = normalizeRowCount(weekly.rowCount, 13);
  result.weekly.rowTimes = normalizeRowTimes(weekly.rowTimes, result.weekly.rowCount, duration);
  result.weekly.slots = (Array.isArray(weekly.slots) ? weekly.slots : []).map(normalizeWeeklySlot).filter(Boolean);
  result.events = (Array.isArray(saved.events) ? saved.events : []).map(normalizeEvent).filter(Boolean);
  result.eventArchive = Array.isArray(saved.eventArchive)
    ? saved.eventArchive.filter((item) => item && item.event).slice(-240)
    : [];
  result.todoReminderTimes = normalizeReminderTimes(saved.todoReminderTimes);
  if (!result.todoReminderTimes.length) result.todoReminderTimes = cloneDefault().todoReminderTimes;
  result.reminderState = saved.reminderState && typeof saved.reminderState === 'object' ? saved.reminderState : {};
  result.version = 1;
  return result;
}

function writeStore(store) {
  ensureDataDirectories();
  const tempPath = `${PLANS_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, PLANS_PATH);
}

function readRawStore() {
  ensureDataDirectories();
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(PLANS_PATH, 'utf8')));
  } catch {
    const fallback = cloneDefault();
    writeStore(fallback);
    return fallback;
  }
}

function eventEndDate(event) {
  const start = new Date(event.startAt);
  if (event.endAt) {
    const end = new Date(event.endAt);
    if (!Number.isNaN(end.getTime())) return end;
  }
  return new Date(start.getTime() + 60 * 60 * 1000);
}

function prepareStore(store, now = new Date()) {
  let changed = false;
  const bucketDate = effectiveDateKey(now);
  if (!store.today.bucketDate) {
    store.today.bucketDate = bucketDate;
    changed = true;
  } else if (store.today.bucketDate !== bucketDate) {
    if (store.today.items.length) {
      store.todayArchive.push({ date: store.today.bucketDate, items: store.today.items, archivedAt: now.toISOString() });
      store.todayArchive = store.todayArchive.slice(-120);
    }
    store.today = { bucketDate, items: [] };
    changed = true;
  }
  // Timed plans are informational schedules, not manual checklists. Once a
  // plan reaches its end time (or its start time when no end was supplied),
  // mark it complete automatically. All-day entries intentionally remain
  // untouched because they are the user's manual to-dos.
  for (const item of store.today.items) {
    if (item.done || item.allDay) continue;
    const completionTime = item.endTime || item.startTime;
    const completionAt = parseLocalDateTime(bucketDate, completionTime);
    if (completionAt && completionAt.getTime() <= now.getTime()) {
      item.done = true;
      item.updatedAt = now.toISOString();
      changed = true;
    }
  }
  const activeEvents = [];
  const endedEvents = [];
  for (const event of store.events) {
    const eventStart = new Date(event.startAt);
    if (!event.done && !Number.isNaN(eventStart.getTime()) && eventStart.getTime() <= now.getTime()) {
      event.done = true;
      event.updatedAt = now.toISOString();
      changed = true;
    }
    if (eventEndDate(event).getTime() <= now.getTime()) endedEvents.push(event);
    else activeEvents.push(event);
  }
  if (endedEvents.length) {
    store.eventArchive.push(...endedEvents.map((event) => ({ event, archivedAt: now.toISOString() })));
    store.eventArchive = store.eventArchive.slice(-240);
    store.events = activeEvents;
    changed = true;
  }
  // Keep reminder state bounded to recent date keys and existing events.
  const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  for (const key of Object.keys(store.reminderState)) {
    const match = /^(?:(?:today|todo|weekly):)?(\d{4}-\d{2}-\d{2})/.exec(key);
    if (match) {
      const date = dateFromKey(match[1]);
      if (date && date < cutoff) { delete store.reminderState[key]; changed = true; }
    }
  }
  if (changed) writeStore(store);
  return store;
}

function readPlans(now = new Date()) {
  return prepareStore(readRawStore(), now);
}

function savePlans(patch = {}) {
  const store = readPlans();
  if (patch.today && Array.isArray(patch.today.items)) {
    store.today.items = patch.today.items.map(normalizeTodayItem).filter(Boolean);
  }
  if (patch.weekly && typeof patch.weekly === 'object') {
    const requestedDuration = patch.weekly.durationMinutes ?? patch.weekly.stepMinutes;
    if (Number.isFinite(Number(requestedDuration))) {
      store.weekly.durationMinutes = normalizeDuration(requestedDuration, store.weekly.durationMinutes);
      store.weekly.stepMinutes = store.weekly.durationMinutes;
    }
    if (Number.isFinite(Number(patch.weekly.rowCount))) store.weekly.rowCount = normalizeRowCount(patch.weekly.rowCount, store.weekly.rowCount);
    if (Array.isArray(patch.weekly.rowTimes)) store.weekly.rowTimes = normalizeRowTimes(patch.weekly.rowTimes, store.weekly.rowCount, store.weekly.durationMinutes);
    if (Array.isArray(patch.weekly.slots)) store.weekly.slots = patch.weekly.slots.map(normalizeWeeklySlot).filter(Boolean);
  }
  if (Array.isArray(patch.events)) store.events = patch.events.map(normalizeEvent).filter(Boolean);
  if (Array.isArray(patch.todoReminderTimes)) store.todoReminderTimes = normalizeReminderTimes(patch.todoReminderTimes);
  writeStore(store);
  return prepareStore(store);
}

function addTodayPlan(input = {}) {
  const store = readPlans();
  const item = normalizeTodayItem({ ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
  if (!item) throw new Error('计划名称不能为空。');
  store.today.items.push(item);
  writeStore(store);
  return store;
}

function updateTodayPlan(id, patch = {}) {
  const store = readPlans();
  const index = store.today.items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error('今日计划不存在或已归档。');
  const next = normalizeTodayItem({ ...store.today.items[index], ...patch, id, updatedAt: new Date().toISOString() });
  if (!next) throw new Error('计划名称不能为空。');
  store.today.items[index] = next;
  writeStore(store);
  return store;
}

function deleteTodayPlan(id) {
  const store = readPlans();
  store.today.items = store.today.items.filter((item) => item.id !== id);
  writeStore(store);
  return store;
}

function updateWeeklySettings(settings = {}) {
  const store = readPlans();
  if (Number.isFinite(Number(settings.durationMinutes))) {
    store.weekly.durationMinutes = normalizeDuration(settings.durationMinutes, store.weekly.durationMinutes);
    store.weekly.stepMinutes = store.weekly.durationMinutes;
  }
  if (Number.isFinite(Number(settings.rowCount))) store.weekly.rowCount = normalizeRowCount(settings.rowCount, store.weekly.rowCount);
  if (Array.isArray(settings.rowTimes)) store.weekly.rowTimes = normalizeRowTimes(settings.rowTimes, store.weekly.rowCount, store.weekly.durationMinutes);
  if (!Array.isArray(store.weekly.rowTimes) || store.weekly.rowTimes.length !== store.weekly.rowCount) {
    store.weekly.rowTimes = normalizeRowTimes(store.weekly.rowTimes, store.weekly.rowCount, store.weekly.durationMinutes);
  }
  writeStore(store);
  return store;
}

function upsertWeeklySlots(slots = [], durationMinutes = 45) {
  const store = readPlans();
  if (Number.isFinite(Number(durationMinutes))) {
    store.weekly.durationMinutes = normalizeDuration(durationMinutes, store.weekly.durationMinutes);
    store.weekly.stepMinutes = store.weekly.durationMinutes;
  }
  const updates = Array.isArray(slots) ? slots : [];
  const updateKeys = new Set(updates.map((slot) => `${Number(slot.day) || 0}|${normalizeTime(slot.start)}`));
  store.weekly.slots = store.weekly.slots.filter((slot) => !updateKeys.has(`${slot.day}|${slot.start}`));
  store.weekly.slots.push(...updates.map(normalizeWeeklySlot).filter(Boolean));
  writeStore(store);
  return store;
}

function addEvent(input = {}) {
  const store = readPlans();
  const event = normalizeEvent({ ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
  if (!event) throw new Error('日程名称和开始时间不能为空。');
  store.events.push(event);
  store.events.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  writeStore(store);
  return store;
}

function updateEvent(id, patch = {}) {
  const store = readPlans();
  const index = store.events.findIndex((event) => event.id === id);
  if (index < 0) throw new Error('日程不存在或已结束。');
  const event = normalizeEvent({ ...store.events[index], ...patch, id, updatedAt: new Date().toISOString() });
  if (!event) throw new Error('日程名称和开始时间不能为空。');
  store.events[index] = event;
  store.events.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  writeStore(store);
  return store;
}

function deleteEvent(id) {
  const store = readPlans();
  store.events = store.events.filter((event) => event.id !== id);
  writeStore(store);
  return store;
}

function markTodayDone(id, done = true) {
  return updateTodayPlan(id, { done: done === true });
}

function markEventDone(id, done = true) {
  return updateEvent(id, { done: done === true });
}

function setTodoReminderTimes(values) {
  const store = readPlans();
  store.todoReminderTimes = normalizeReminderTimes(values);
  writeStore(store);
  return store;
}

function parseLocalDateTime(dateKey, time) {
  const normalized = normalizeTime(time);
  if (!dateKey || !normalized) return null;
  const result = new Date(`${dateKey}T${normalized}:00`);
  return Number.isNaN(result.getTime()) ? null : result;
}

function pendingTodoTitles(store) {
  return store.today.items.filter((item) => item.allDay && !item.done).map((item) => item.title);
}

function isReminderTimeDue(now, time) {
  const normalized = normalizeTime(time);
  if (!normalized) return false;
  const [hour, minute] = normalized.split(':').map(Number);
  const current = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const target = hour * 60 + minute;
  // The plan monitor runs every 30 seconds. A two-minute window prevents a
  // short scheduling delay from skipping a manually entered reminder.
  return current >= target && current < target + 2;
}

function weeklySlotEventKey(slot) {
  return String(slot?.event || slot?.title || '').trim().toLocaleLowerCase();
}

function weeklySlotRowIndex(slot, rowTimes) {
  const normalizedStart = normalizeTime(slot?.start);
  const row = rowTimes.indexOf(normalizedStart);
  if (row >= 0) return row;
  // Older data may not have a matching row header.  A minute value still gives
  // us a useful ordering and lets contiguous slots be merged when their end
  // time is the next slot's start time.
  if (!normalizedStart) return Number.POSITIVE_INFINITY;
  const [hour, minute] = normalizedStart.split(':').map(Number);
  return hour * 60 + minute;
}

function buildWeeklyReminderGroups(slots, rowTimes = []) {
  const normalizedRows = Array.isArray(rowTimes) ? rowTimes.map(normalizeTime) : [];
  const ordered = (Array.isArray(slots) ? slots : [])
    .map((slot, index) => ({ slot, index, row: weeklySlotRowIndex(slot, normalizedRows) }))
    .sort((left, right) => left.row - right.row || String(left.slot.start).localeCompare(String(right.slot.start)) || left.index - right.index);
  const groups = [];
  for (const entry of ordered) {
    const previous = groups[groups.length - 1];
    const eventKey = weeklySlotEventKey(entry.slot);
    const rowsAdjacent = previous && Number.isFinite(previous.lastRow) && Number.isFinite(entry.row)
      ? entry.row === previous.lastRow + 1
      : previous && normalizeTime(previous.item.end) && normalizeTime(previous.item.end) === normalizeTime(entry.slot.start);
    if (previous && previous.eventKey === eventKey && rowsAdjacent) {
      previous.lastRow = entry.row;
      previous.item.end = entry.slot.end || previous.item.end;
      if (!previous.item.location && entry.slot.location) previous.item.location = entry.slot.location;
      previous.reminderTimes = normalizeReminderTimes([...previous.reminderTimes, ...normalizeReminderTimes(entry.slot.reminderTimes, 3)], 3);
      continue;
    }
    groups.push({
      id: String(entry.slot.id || `${entry.slot.day}-${entry.slot.start}`),
      eventKey,
      item: { ...entry.slot },
      lastRow: entry.row,
      reminderTimes: normalizeReminderTimes(entry.slot.reminderTimes, 3)
    });
  }
  return groups;
}

function consumeDueReminders(now = new Date()) {
  const store = readPlans(now);
  const reminders = [];
  const dateKey = localDateKey(now);
  const effectiveKey = store.today.bucketDate || effectiveDateKey(now);
  const add = (key, payload) => {
    if (store.reminderState[key]) return;
    store.reminderState[key] = now.toISOString();
    reminders.push(payload);
  };
  const withinWindow = (start) => {
    if (!start) return false;
    const diff = start.getTime() - now.getTime();
    return diff >= 0 && diff <= REMINDER_WINDOW_MS;
  };
  for (const item of store.today.items) {
    if (item.done || item.allDay) continue;
    const start = parseLocalDateTime(effectiveKey, item.startTime);
    if (withinWindow(start)) add(`today:${effectiveKey}:${item.id}`, { type: 'today', item, startsAt: start.toISOString() });
  }
  const weekDay = now.getDay();
  const weeklySlots = store.weekly.slots.filter((item) => item.day === weekDay);
  for (const group of buildWeeklyReminderGroups(weeklySlots, store.weekly.rowTimes)) {
    const slot = group.item;
    const start = parseLocalDateTime(dateKey, slot.start);
    const reminderTimes = group.reminderTimes;
    if (reminderTimes.length) {
      for (const reminderTime of reminderTimes) {
        if (isReminderTimeDue(now, reminderTime)) {
          add(`weekly:${dateKey}:${group.id}:${reminderTime}`, {
            type: 'weekly', item: slot, startsAt: start?.toISOString?.() || '', reminderTime
          });
        }
      }
    } else if (withinWindow(start)) {
      // Preserve the original behaviour for legacy slots with no explicit
      // reminders: one notification in the 15-minute pre-start window.
      add(`weekly:${dateKey}:${group.id}:before-start`, { type: 'weekly', item: slot, startsAt: start.toISOString() });
    }
  }
  for (const event of store.events) {
    if (event.done) continue;
    const start = new Date(event.startAt);
    if (withinWindow(start)) add(`event:${event.id}:${event.startAt}`, { type: 'event', item: event, startsAt: start.toISOString() });
  }
  const todos = pendingTodoTitles(store);
  if (todos.length) {
    const minuteNow = now.getHours() * 60 + now.getMinutes();
    for (const time of store.todoReminderTimes) {
      const [hour, minute] = time.split(':').map(Number);
      const target = hour * 60 + minute;
      if (minuteNow >= target && minuteNow < target + 2) {
        add(`todo:${effectiveKey}:${time}`, { type: 'todo', items: todos, reminderTime: time });
      }
    }
  }
  if (reminders.length) writeStore(store);
  return { reminders, store };
}

function exportPlans(targetPath) {
  const store = readPlans();
  const resolved = path.resolve(targetPath || path.join(DATA_DIR, `plans-export-${Date.now()}.json`));
  fs.writeFileSync(resolved, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  return resolved;
}

function deleteAllPlanData(includeArchive = false) {
  const current = readPlans();
  const store = cloneDefault();
  store.today.bucketDate = current.today.bucketDate || effectiveDateKey();
  // “清空当前计划” removes active entries only.  Archived daily schedules
  // and ended events remain available for viewing/export as required.
  if (!includeArchive) {
    store.todayArchive = current.todayArchive;
    store.eventArchive = current.eventArchive;
  }
  writeStore(store);
  return store;
}

module.exports = {
  PLANS_PATH,
  DAY_ROLLOVER_HOUR,
  readPlans,
  savePlans,
  addTodayPlan,
  updateTodayPlan,
  deleteTodayPlan,
  markTodayDone,
  upsertWeeklySlots,
  addEvent,
  updateEvent,
  deleteEvent,
  markEventDone,
  setTodoReminderTimes,
  updateWeeklySettings,
  consumeDueReminders,
  exportPlans,
  deleteAllPlanData,
  effectiveDateKey,
  localDateKey
};
