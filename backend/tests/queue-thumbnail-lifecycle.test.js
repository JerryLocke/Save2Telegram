import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the real queue storage operations without touching Chrome storage.
function loadQueue(records) {
  const storage = { forwardQueue: structuredClone(records) };
  const context = vm.createContext({
    chrome: {
      storage: { local: {
        get: async key => ({ [key]: structuredClone(storage[key]) }),
        set: async values => Object.assign(storage, structuredClone(values))
      } },
      action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} }
    },
    getGeneralSettings: async () => ({ keepCompletedItems: true })
  });
  vm.runInContext(`const QUEUE_KEY = 'forwardQueue';
    let queueUpdatePromise = Promise.resolve();
    const activeQueueAbortControllers = new Map();
    const ALLOWED_COMPLETED_RECORD_COUNTS = [5, 10, 30];
    const DEFAULT_GENERAL_SETTINGS = { maxCompletedItems: 5 };`, context);
  vm.runInContext(fs.readFileSync(new URL('../../crx/background/queue.js', import.meta.url), 'utf8'), context);
  return { storage, run: code => vm.runInContext(code, context) };
}

function record(id, status = 'sent', createdAt = 0) {
  return { id, status, createdAt, payload: { source: 'telegram', mediaItems: Array.from({ length: 3 }, (_, i) => (
    { type: i ? 'photo' : 'video', messageId: i + 1, thumbnail: `data:image/jpeg;base64,preview-${id}-${i}` }
  )) } };
}

test('deleting a queue item also deletes its thumbnail with no separate cache', async () => {
  const { storage, run } = loadQueue([record('removed'), record('kept')]);
  await run('removeQueueItem("removed")');
  assert.deepEqual(Object.keys(storage), ['forwardQueue']);
  assert.ok(!JSON.stringify(storage).includes('preview-removed'));
  assert.ok(JSON.stringify(storage).includes('preview-kept'));
});

test('clearing completed records retains pending/failed previews only', async () => {
  const { storage, run } = loadQueue([record('sent'), record('pending', 'pending'), record('failed', 'error')]);
  await run('clearCompletedQueueItems()');
  assert.deepEqual(storage.forwardQueue.map(item => item.id), ['pending', 'failed']);
  assert.ok(!JSON.stringify(storage).includes('preview-sent'));
});

test('retention limits remove the older completed thumbnails', async () => {
  const { storage, run } = loadQueue(Array.from({ length: 7 }, (_, i) => record(String(i), 'sent', i)));
  await run('trimCompletedQueueItems(5)');
  assert.deepEqual(storage.forwardQueue.map(item => item.id), ['2', '3', '4', '5', '6']);
  assert.ok(!JSON.stringify(storage).includes('preview-0'));
  assert.ok(!JSON.stringify(storage).includes('preview-1'));
});
