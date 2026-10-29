import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatFileSize,
  normalizeHubUrl,
  renderItems,
  splitText,
  websocketUrl,
} from '../lib/hub.js';
import {
  assistantReasoning,
  assistantText,
  commandOf,
  composeBody,
  isAllowed,
  stripSenderTag,
  toolCallText,
  toolResultText,
  turnFailure,
} from '../lib/gateway.js';
import { channelInstance, deriveSessionId, sessionSeed, SessionRegistry } from '../lib/sessions.js';
import { detectImageMediaType, imageItems } from '../lib/media.js';
import { HubClient } from '../lib/hub.js';

test('normalizeHubUrl 去掉尾部斜杠', () => {
  assert.equal(normalizeHubUrl('https://hub.openilink.com/'), 'https://hub.openilink.com');
  assert.equal(normalizeHubUrl('  https://hub.openilink.com///  '), 'https://hub.openilink.com');
  assert.equal(normalizeHubUrl(''), '');
  assert.equal(normalizeHubUrl(undefined), '');
});

test('websocketUrl 由 http(s) 推导 ws(s)', () => {
  assert.equal(
    websocketUrl('https://hub.openilink.com', 'app_1'),
    'wss://hub.openilink.com/bot/v1/ws?token=app_1',
  );
  assert.equal(websocketUrl('http://localhost:9200/', 'a b'), 'ws://localhost:9200/bot/v1/ws?token=a%20b');
  assert.throws(() => websocketUrl('', 't'));
});

test('formatFileSize', () => {
  assert.equal(formatFileSize(500), '500B');
  assert.equal(formatFileSize(1536), '1.5KB');
  assert.equal(formatFileSize(5.5 * 1024 * 1024), '5.5MB');
  assert.equal(formatFileSize(0), '');
});

test('renderItems 无 items 时原样返回 content', () => {
  assert.equal(renderItems('hello', 'text', undefined), 'hello');
  assert.equal(renderItems('hello', 'text', []), 'hello');
});

test('renderItems 提取文本项', () => {
  assert.equal(renderItems('', 'text', [{ type: 'text', text: 'hi' }]), 'hi');
});

test('renderItems 渲染文件项（名称、大小、URL）', () => {
  const body = renderItems('', 'file', [
    { type: 'file', file_name: 'report.pdf', media: { url: 'https://hub/x', file_size: 2048 } },
  ]);
  assert.match(body, /\[File: report\.pdf \(2\.0KB\)\]/);
  assert.match(body, /https:\/\/hub\/x/);
});

test('renderItems 媒体 caption 不重复', () => {
  const body = renderItems('看看这个', 'image', [
    { type: 'text', text: '看看这个' },
    { type: 'image', media: { url: 'https://hub/i' } },
  ]);
  assert.equal(body.split('看看这个').length - 1, 1);
  assert.match(body, /\[Image\]/);
});

test('renderItems 保留 caption 当 items 里没有文本项', () => {
  const body = renderItems('Please review', 'file', [
    { type: 'file', file_name: 'doc.pdf', media: { file_size: 2048 } },
  ]);
  assert.equal(body, 'Please review\n[File: doc.pdf (2.0KB)]');
});

test('renderItems 渲染语音/视频时长', () => {
  assert.match(renderItems('', 'voice', [{ type: 'voice', media: { play_time: 5 } }]), /\[Voice 5s\]/);
  assert.match(renderItems('', 'video', [{ type: 'video', media: { play_length: 30 } }]), /\[Video 30s\]/);
});

test('splitText 短文本不分段', () => {
  assert.deepEqual(splitText('hello', 4000), ['hello']);
  assert.deepEqual(splitText('', 4000), []);
});

test('splitText 在换行边界切分且不丢内容', () => {
  const text = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n');
  const chunks = splitText(text, 40);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 40, `chunk too long: ${chunk.length}`);
  assert.equal(chunks.join('\n').replace(/\n+/g, '\n'), text.replace(/\n+/g, '\n'));
});

test('isAllowed 按访问模式判定', () => {
  assert.equal(isAllowed({ mode: 'open', allow: [] }, 'u1'), true);
  assert.equal(isAllowed({ mode: 'allow', allow: ['u1'] }, 'u1'), true);
  assert.equal(isAllowed({ mode: 'allow', allow: ['u2'] }, 'u1'), false);
});

test('composeBody 群聊加发送者标签', () => {
  const data = { content: 'hi', sender: { id: 'u1', name: '张三' }, items: [{ type: 'text', text: 'hi' }] };
  assert.equal(composeBody(data, 'direct'), 'hi');
  assert.equal(composeBody(data, 'group'), '[张三 (u1)] hi');
});

test('assistantText 拼接文本块并忽略 reasoning', () => {
  assert.equal(
    assistantText({
      content: [
        { type: 'reasoning', text: '思考' },
        { type: 'text', text: '你好' },
        { type: 'text', text: '世界' },
      ],
    }),
    '你好\n世界',
  );
  assert.equal(assistantText(undefined), '');
});

test('assistantReasoning 提取思考块并保持顺序', () => {
  assert.equal(
    assistantReasoning({
      content: [
        { type: 'reasoning', text: '先看一' },
        { type: 'text', text: '正文' },
        { type: 'reasoning', text: ' 再看二 ' },
      ],
    }),
    '先看一\n\n再看二',
  );
  assert.equal(assistantReasoning({ content: [{ type: 'text', text: 'hi' }] }), '');
  assert.equal(assistantReasoning(undefined), '');
});

test('toolCallText 渲染工具名与参数', () => {
  assert.match(toolCallText('bash', '{"command":"ls"}'), /🔧 调用 `bash`/);
  assert.match(toolCallText('bash', '{"command":"ls"}'), /command/);
  assert.equal(toolCallText('openilink_status', '{}'), '🔧 调用 `openilink_status`');
  // 非法 JSON 原样展示，不抛错。
  assert.match(toolCallText('x', 'not-json'), /not-json/);
});

test('toolResultText 区分成功与失败', () => {
  const ok = toolResultText('read', { message: { content: [{ type: 'text', text: 'file body' }] } });
  assert.match(ok, /✅ 完成 `read`/);
  assert.match(ok, /file body/);

  const failed = toolResultText('bash', {
    message: { content: [{ type: 'text', text: 'exit 1' }] },
    error: { name: 'Error', code: 'E_BASH', reason: '命令失败' },
  });
  assert.match(failed, /⚠️ 失败 `bash`/);
  assert.match(failed, /E_BASH/);
  assert.match(failed, /命令失败/);
});

test('stripSenderTag / commandOf 剥掉群聊发送者标签', () => {
  assert.equal(stripSenderTag('[张三 (u1)] /model'), '/model');
  assert.equal(stripSenderTag('/new'), '/new');
  assert.equal(commandOf('[张三 (u1)] /MODEL deepseek/x'), '/model deepseek/x');
  assert.equal(commandOf('[张三 (u1)] 你好'), '你好');
  // 只取首行，避免正文里的斜杠被当成命令。
  assert.equal(commandOf('第一行\n/model'), '第一行');
});

test('turnFailure 只识别 error 形态', () => {
  assert.equal(turnFailure({ kind: 'completed' }), undefined);
  assert.deepEqual(turnFailure({ kind: 'error', error: { code: 'X', message: 'boom' } }), {
    code: 'X',
    message: 'boom',
  });
});

test('会话 id 由 seed 确定性派生，并符合 im-connect 频道约定', () => {
  const seed = sessionSeed('bot-1', 'direct', 'u1');
  assert.equal(deriveSessionId(seed), deriveSessionId(seed));
  assert.equal(deriveSessionId(seed), `im:${channelInstance('bot-1')}:dm:u1`);
  assert.notEqual(deriveSessionId(seed), deriveSessionId(sessionSeed('bot-1', 'group', 'u1')));
  assert.equal(
    deriveSessionId(sessionSeed('bot-1', 'group', 'g@chatroom')),
    `im:${channelInstance('bot-1')}:group:g@chatroom`,
  );
});

test('不同 Bot 的同一 peer 不会撞进同一个会话 id', () => {
  // 两个 Bot 各自被同一个微信用户私聊：peer id 相同，会话必须分开。
  const a = deriveSessionId(sessionSeed('bot-a', 'direct', 'u1'));
  const b = deriveSessionId(sessionSeed('bot-b', 'direct', 'u1'));
  assert.notEqual(a, b);
  assert.equal(channelInstance('bot-a'), channelInstance('bot-a'));
  assert.notEqual(channelInstance('bot-a'), channelInstance('bot-b'));
});

test('会话 id 的渠道段满足 im-connect 的解析约束', async () => {
  // 约束来自 @michengai/dsh-im-connect 的 parseImSessionId：平台前缀在已知列表内、
  // 整段 ^[a-z0-9_-]+$、kind 为 dm/group、chatId 非空。
  const known = ['dingtalk', 'feishu', 'lark', 'weixin', 'wecom', 'qq', 'telegram', 'discord', 'slack'];
  for (const kind of ['direct', 'group']) {
    const id = deriveSessionId(sessionSeed('bot-1', kind, 'peer@im.wechat'));
    const parts = id.slice('im:'.length).split(':');
    assert.equal(parts.length, 3, `id 分段应为 channel:kind:chatId：${id}`);
    const [channel, idKind, chatId] = parts;
    assert.match(channel, /^[a-z0-9_-]+$/);
    assert.equal(channel.split('_')[0], 'weixin', '平台前缀决定频道分组');
    assert.ok(known.includes(channel.split('_')[0]), `平台前缀须在已知列表内：${channel}`);
    assert.ok(idKind === 'dm' || idKind === 'group');
    assert.notEqual(chatId, '');
  }
});

test('peer 含冒号时仍解析成干净的 chatId', () => {
  // 微信 id 常带 `:`，不能让它把 id 分段撑乱。
  assert.equal(
    deriveSessionId(sessionSeed('bot-1', 'direct', 'user:with:colons@im.wechat')),
    `im:${channelInstance('bot-1')}:dm:user:with:colons@im.wechat`,
  );
});

test('SessionRegistry 轮换会话后 id 改变且记录递增', () => {
  const registry = new SessionRegistry();
  const first = registry.identity('bot-1', 'direct', 'u1');
  assert.equal(first.generation, 0);
  const rotated = registry.rotate('bot-1', 'direct', 'u1', 1792399242749);
  assert.equal(rotated.generation, 1);
  assert.notEqual(rotated.sessionId, first.sessionId);
  assert.equal(rotated.sessionId, `im:${channelInstance('bot-1')}:dm:1792399242749:u1`);
  assert.equal(registry.identity('bot-1', 'direct', 'u1').sessionId, rotated.sessionId);
});

test('轮换后的 id 被 im-connect 剥离时间戳后回到同一 peer', () => {
  // im-connect 的 parseImSessionId 只剥「纯数字」时间戳段，剥完 chatId 必须还是 peer。
  for (const [kind, peer] of [['direct', 'u1'], ['group', '123@chatroom']]) {
    const id = deriveSessionId(`openilink:bot-1:${kind}:${peer}#rot=1792399242749`);
    const segments = id.slice('im:'.length).split(':');
    const [channel, idKind, stamp, ...rest] = segments;
    assert.equal(channel, channelInstance('bot-1'));
    assert.equal(idKind, kind === 'direct' ? 'dm' : 'group');
    assert.match(stamp, /^\d{13,}$/);
    assert.equal(rest.join(':'), peer);
  }
});

test('detectImageMediaType 按魔数识别', () => {
  assert.equal(detectImageMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/png');
  assert.equal(detectImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
  assert.equal(detectImageMediaType(gif), 'image/gif');
  const webp = new Uint8Array(12);
  webp.set([0x52, 0x49, 0x46, 0x46], 0);
  webp.set([0x57, 0x45, 0x42, 0x50], 8);
  assert.equal(detectImageMediaType(webp), 'image/webp');
  assert.equal(detectImageMediaType(new TextEncoder().encode('<html>nope</html>')), undefined);
});

test('imageItems 只取可下载的图片项并限流', () => {
  const items = [
    { type: 'text', text: 'x' },
    { type: 'image', media: { url: 'https://hub/1' } },
    { type: 'image', media: { url: 'file:///etc/passwd' } },
    { type: 'file', file_name: 'a.pdf', media: { url: 'https://hub/f' } },
  ];
  const images = imageItems(items);
  assert.equal(images.length, 1);
  assert.equal(images[0].url, 'https://hub/1');
});

// ── HubClient.info()：缺 bot:read scope 不等于凭据无效 ──────────────
//
// Hub 的 appTokenAuth 先用 GetInstallationByToken 校验 token，通过后才查
// scope。内置 App（openclaw / bridge / runner）只声明 message:read +
// message:write，所以一个能正常收发微信的 Token 调 /bot/v1/info 必然拿到
// 403 `missing scope: bot:read`。旧实现把它当凭据错误，设置页就报
// “连接失败：Hub 返回 403”，用户填了正确的 Token 也存不进去。

function fakeFetch(status, body) {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
}

test('info() 遇到 403 missing scope 时视为凭据有效，只给 warning', async () => {
  const client = new HubClient({
    hubUrl: 'http://hub.test',
    appToken: 'app_ok',
    fetchImpl: fakeFetch(403, { ok: false, error: 'missing scope: bot:read' }),
  });
  const result = await client.info();
  assert.equal(result.ok, true, '缺 scope 不应被当成凭据错误');
  assert.match(result.warning, /bot:read/);
});

test('info() 遇到 401 判定凭据无效', async () => {
  const client = new HubClient({
    hubUrl: 'http://hub.test',
    appToken: 'app_bad',
    fetchImpl: fakeFetch(401, { ok: false, error: 'invalid token' }),
  });
  const result = await client.info();
  assert.equal(result.ok, false);
  assert.match(result.error, /凭据无效/);
});

test('info() 遇到其它错误码仍然报错', async () => {
  const client = new HubClient({
    hubUrl: 'http://hub.test',
    appToken: 'app_ok',
    fetchImpl: fakeFetch(500, { ok: false, error: 'boom' }),
  });
  const result = await client.info();
  assert.equal(result.ok, false);
  assert.match(result.error, /500/);
});

test('info() 正常返回 bot 信息', async () => {
  const client = new HubClient({
    hubUrl: 'http://hub.test',
    appToken: 'app_ok',
    fetchImpl: fakeFetch(200, { ok: true, bot: { id: 'b1', name: '小助手' } }),
  });
  const result = await client.info();
  assert.equal(result.ok, true);
  assert.equal(result.bot.name, '小助手');
  assert.equal(result.warning, undefined);
});
