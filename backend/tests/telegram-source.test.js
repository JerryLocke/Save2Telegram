import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:8081';
process.env.TELEGRAM_SEND_MIN_INTERVAL_MS = '0';
const { normalizeTelegramSource, forwardTelegramSource } = await import('../telegram-source.js');
const { forwardEndpoint } = await import('../forwarder.js');
const source = { chatId: '-1001234567890', chatUsername: '@source_channel', messageIds: [7, 6, 7] };
const payload = { source: 'telegram', telegramSource: source, tweetUrl: 'https://t.me/c/1234567890/6' };
const telegram = { botToken: 'test-token', chatId: '-1009876543210' };

function mockApi(t, { protectedContent = false, sourceId = source.chatId, forwarded = [101, 102], apiError = null, sourceError = false } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'http://127.0.0.1:8081', 'must use Docker Bot API base');
    const method = parsed.pathname.split('/').at(-1);
    const body = JSON.parse(options.body);
    calls.push({ method, body, signal: options.signal });
    if (method === 'getChat') {
      if (sourceError && body.chat_id !== telegram.chatId) {
        return Response.json({ ok: false, description: 'Bad Request: chat not found' }, { status: 400 });
      }
      return Response.json({ ok: true, result: body.chat_id === telegram.chatId
        ? { id: telegram.chatId } : { id: sourceId, has_protected_content: protectedContent } });
    }
    assert.ok(['forwardMessages', 'copyMessages'].includes(method), 'must never download media or send text/uploads');
    return apiError ? Response.json(apiError, { status: 400 })
      : Response.json({ ok: true, result: forwarded.map(message_id => ({ message_id })) });
  });
  return calls;
}

test('normalizes channel IDs and deduplicates/sorts album IDs', () => {
  assert.deepEqual(normalizeTelegramSource(source), { ...source, messageIds: [6, 7] });
});

test('rejects malformed, DOM, ephemeral, fractional and empty message IDs', () => {
  for (const ids of [[], [0], [-1], ['7'], [1.5], [NaN], [0x100000006], [0x200000006], Array(101).fill(1)]) {
    assert.throws(() => normalizeTelegramSource({ ...source, messageIds: ids }), /Invalid Telegram/);
  }
  for (const chatId of ['123', '-456', 'https://example.com', '-0', '-9007199254740992']) {
    assert.throws(() => normalizeTelegramSource({ ...source, chatId }), /Invalid Telegram/);
  }
  assert.throws(() => normalizeTelegramSource({ ...source, chatUsername: '@wrong/path' }), /Invalid Telegram/);
});

test('forwards a whole album through configured Bot API with no download/upload', async t => {
  const calls = mockApi(t);
  const result = await forwardEndpoint.forward(payload, telegram);
  assert.equal(result.length, 2);
  assert.deepEqual(calls.map(c => c.method), ['getChat', 'getChat', 'forwardMessages']);
  assert.equal(calls[1].body.chat_id, source.chatUsername);
  assert.deepEqual(calls[2].body, { chat_id: telegram.chatId, from_chat_id: source.chatId, message_ids: [6, 7] });
});

test('forwards single media messages and numeric private-channel sources', async t => {
  const calls = mockApi(t, { forwarded: [101] });
  await forwardEndpoint.forward({ ...payload, telegramSource: { chatId: source.chatId, messageIds: [6] } }, telegram);
  assert.equal(calls[1].body.chat_id, source.chatId);
  assert.deepEqual(calls.at(-1).body.message_ids, [6]);
});

test('copies page-marked protected messages after checking bot access', async t => {
  const calls = mockApi(t);
  await forwardEndpoint.forward({ ...payload, telegramSource: { ...source, protectedContent: true } }, telegram);
  assert.deepEqual(calls.map(c => c.method), ['getChat', 'getChat', 'copyMessages']);
  assert.deepEqual(calls.at(-1).body.message_ids, [6, 7]);
  assert.equal(calls.at(-1).body.remove_caption, undefined, 'keep original captions');
});

test('uses copyMessages when only the server reports content protection', async t => {
  const calls = mockApi(t, { protectedContent: true });
  await forwardEndpoint.forward(payload, telegram);
  assert.equal(calls.at(-1).method, 'copyMessages');
});

test('copying still requires the bot to access the source chat', async t => {
  const calls = mockApi(t, { sourceError: true });
  await assert.rejects(forwardEndpoint.forward({ ...payload, telegramSource: { ...source, protectedContent: true } }, telegram), /chat not found/);
  assert.ok(calls.every(c => c.method === 'getChat'));
});

test('partial copies fail without duplicating successfully copied messages', async t => {
  const calls = mockApi(t, { protectedContent: true, forwarded: [101] });
  await assert.rejects(forwardEndpoint.forward(payload, telegram), /copied 1\/2.*retry may duplicate/);
  assert.equal(calls.filter(c => c.method === 'copyMessages').length, 1);
});

test('copy API errors propagate without attempting uploads or forwarding again', async t => {
  const calls = mockApi(t, { protectedContent: true, apiError: { ok: false, description: 'Bad Request: message cannot be copied' } });
  await assert.rejects(forwardEndpoint.forward(payload, telegram), /message cannot be copied/);
  assert.deepEqual(calls.map(c => c.method), ['getChat', 'getChat', 'copyMessages']);
});

test('rejects username reassignment or a chat navigation race', async t => {
  const calls = mockApi(t, { sourceId: '-1001111111111' });
  await assert.rejects(forwardEndpoint.forward(payload, telegram), /no longer matches/);
  assert.equal(calls.length, 2);
});

test('partial and empty API results fail without an automatic retry', async t => {
  const calls = mockApi(t, { forwarded: [101] });
  await assert.rejects(forwardEndpoint.forward(payload, telegram), /1\/2.*retry may duplicate/);
  assert.equal(calls.filter(c => c.method === 'forwardMessages').length, 1);
});

test('zero forwarded messages are not reported as success', async t => {
  mockApi(t, { forwarded: [] });
  await assert.rejects(forwardEndpoint.forward(payload, telegram), /0\/2/);
});

test('API failures propagate without downloading or falling back to a text link', async t => {
  const calls = mockApi(t, { apiError: { ok: false, description: 'Bad Request: message to forward not found' } });
  await assert.rejects(forwardEndpoint.forward(payload, telegram), /message to forward not found/);
  assert.equal(calls.length, 3);
});

test('cancelled jobs stop before querying the source', async t => {
  const calls = mockApi(t);
  const abortController = new AbortController();
  abortController.abort();
  await assert.rejects(forwardTelegramSource(payload, telegram, { abortController }), /cancelled/i);
  assert.equal(calls.length, 0);
});

function loadExtension(overrides = {}) {
  const context = vm.createContext({
    __t: (key, args) => `${key} ${(args || []).join('/')}`,
    getTelegramConfigForSend: async () => telegram,
    buildCaption: () => '', getQueue: async () => [],
    ...overrides
  });
  for (const file of ['telegram-source.js', 'endpoints.js']) {
    vm.runInContext(fs.readFileSync(new URL(`../../crx/background/${file}`, import.meta.url), 'utf8'), context);
  }
  return { context, remote: vm.runInContext('new RemoteForwardEndpoint({ endpointUrl: "http://backend.test", endpointKey: "test-key" })', context) };
}

test('extension and backend agree on ID normalization and validation', () => {
  const { context } = loadExtension();
  context.source = source;
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(normalizeTelegramSource(source))', context)), normalizeTelegramSource(source));
  context.source = { ...source, protectedContent: true };
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(normalizeTelegramSource(source))', context)), normalizeTelegramSource(context.source));
  assert.equal(normalizeTelegramSource(context.source).protectedContent, true);
  for (const messageIds of [[], [0], [0x100000006], [1.5], ['6']]) {
    context.source = { ...source, messageIds };
    assert.throws(() => vm.runInContext('normalizeTelegramSource(source)', context));
  }
});

test('old backends are blocked before creating a forward job', async () => {
  let streamed = false;
  const { remote } = loadExtension({ fetch: async () => Response.json({ ok: true }) });
  remote._streamWithSse = async () => { streamed = true; };
  await assert.rejects(remote.forward(payload, 'queue-1'), /bg_telegramUpdateBackend/);
  assert.equal(streamed, false);
});

test('backends with forwarding but no copy support require an update', async () => {
  const { remote } = loadExtension({ fetch: async () => Response.json({ ok: true, capabilities: ['telegram-forward'] }) });
  remote._streamWithSse = async () => assert.fail('must not send to an old backend');
  await assert.rejects(remote.forward(payload, 'queue-1'), /bg_telegramUpdateBackend/);
});

test('remote transport sends only Telegram message references and existing target credentials', async () => {
  let request;
  const { remote } = loadExtension({ fetch: async () => Response.json({ ok: true, capabilities: ['telegram-forward', 'telegram-copy'] }) });
  remote._streamWithSse = async (url, body) => { request = JSON.parse(JSON.stringify(body)); };
  await remote.forward(payload, 'queue-1');
  assert.deepEqual(request.payload, { source: 'telegram', telegramSource: normalizeTelegramSource(source), tweetUrl: payload.tweetUrl });
  assert.deepEqual(request.telegram, telegram);
  await remote.forward({ ...payload, telegramSource: { ...source, protectedContent: true } }, 'queue-2');
  assert.equal(request.payload.telegramSource.protectedContent, true, 'preserve per-message copy hint across transport');
  await remote.forward({ ...payload, mediaItems: [
    { type: 'photo', messageId: 6, thumbnail: 'data:image/jpeg;base64,local-preview-only-photo' },
    { type: 'video', messageId: 8, thumbnail: 'data:image/jpeg;base64,local-preview-only-video' }
  ] }, 'queue-3');
  assert.ok(!JSON.stringify(request).includes('local-preview-only'), 'queue thumbnail stays in the extension, not the backend');
});

test('local extension route forwards IDs, checks source access and marks forwarding phase', async () => {
  const calls = [];
  const { context } = loadExtension({
    validateTelegramChat: async () => ({ id: source.chatId }),
    markQueueItem: async (id, patch) => calls.push(patch),
    appendQueueDebugLog: async () => {},
    callTelegram: async (token, method, body) => {
      calls.push({ method, body: JSON.parse(JSON.stringify(body)) });
      return [{ message_id: 101 }, { message_id: 102 }];
    }
  });
  context.payload = payload;
  context.telegram = telegram;
  await vm.runInContext('forwardTelegramSource(payload, telegram, "queue-1", null)', context);
  assert.equal(calls[0].phase, 'forwarding');
  assert.deepEqual(calls[1], { method: 'forwardMessages', body: { chat_id: telegram.chatId, from_chat_id: source.chatId, message_ids: [6, 7] } });
  context.payload = { ...payload, telegramSource: { ...source, protectedContent: true } };
  await vm.runInContext('forwardTelegramSource(payload, telegram, "queue-2", null)', context);
  assert.equal(calls.at(-1).method, 'copyMessages');
});
