/**
 * 端到端协议测试：真实 WebSocket + 真实 HTTP，Agent 用替身。
 *
 * 覆盖：init、文本事件 → followup、助手回复 → Hub、群聊标签、
 * 访问控制、断线重连、卸载清理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { OpeniLinkGateway } from '../lib/gateway.js';
import { channelInstance } from '../lib/sessions.js';
import { startMockHub } from './mock-hub.mjs';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** 构造一个最小的 Agent 替身。 */
function fakeAgents() {
  const created = [];
  const resumed = [];
  const live = new Map();
  return {
    created,
    resumed,
    get(id) {
      return live.get(id);
    },
    async create(options) {
      const agent = makeAgent(options.sessionId);
      live.set(options.sessionId, agent);
      created.push({ options, agent });
      return { agent, dispose: async () => live.delete(options.sessionId) };
    },
    async resume(options) {
      resumed.push(options);
      // 磁盘上没有这个会话 → 真实 Host 会 reject，网关据此新建。
      throw new Error(`session not found: ${options.resumeSessionId}`);
    },
  };
}

function makeAgent(sessionId) {
  return {
    session: { id: sessionId },
    followedUp: [],
    cancelled: undefined,
    followup(message) {
      this.followedUp.push(message);
    },
    cancel(cause) {
      this.cancelled = cause;
    },
    async whenIdle() {},
  };
}

/** 等待某个条件成立。 */
async function waitFor(predicate, { timeout = 3000, interval = 20 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await delay(interval);
  }
  return false;
}

function makeContext(agents) {
  return {
    agents,
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' }) };
      }
      return undefined;
    },
  };
}

function makeConfig(overrides = {}) {
  return {
    hubUrl: '',
    appToken: 'app_test',
    cwd: process.cwd(),
    agentPreset: '',
    provider: '',
    model: '',
    textChunkLimit: 4000,
    sessionIdleMinutes: 30,
    access: { mode: 'open', allow: [] },
    media: { enabled: false, maxMB: 30, ttlHours: 168 },
    debug: false,
    ...overrides,
  };
}

test('连接 Hub、收到文本事件并 followup 到 Agent', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url, appToken: 'app_test' }),
    logger: silentLogger,
  });
  gateway.connect();

  assert.ok(await waitFor(() => gateway.connectionState === 'connected'), '应连上 Hub');
  hub.pushMessage({ text: '你好，助手' });

  assert.ok(await waitFor(() => agents.created.length === 1), '应创建一个会话');
  const agent = agents.created[0].agent;
  assert.ok(await waitFor(() => agent.followedUp.length === 1), '应 followup 一条消息');

  const content = agent.followedUp[0].content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, '你好，助手');
  assert.equal(agents.created[0].options.agentOptions.provider, 'p');
  assert.equal(agents.created[0].options.agentOptions.reasoningEffort, 'high');

  await gateway.dispose();
  await hub.close();
});

test('助手回复通过 Hub Bot API 发回给发送者', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({ text: 'ping', senderId: 'wxid_a' });
  assert.ok(await waitFor(() => agents.created.length === 1));

  const agent = agents.created[0].agent;
  gateway.onSessionEvent(agent.session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'pong' }] } },
  });

  assert.ok(await waitFor(() => hub.replies.length === 1), '应发出回复');
  assert.deepEqual(hub.replies[0], { type: 'text', content: 'pong', to: 'wxid_a', trace_id: 'trace-1' });

  await gateway.dispose();
  await hub.close();
});

test('群消息带发送者标签，回复发给 group id', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({
    text: '群里提问',
    senderId: 'wxid_b',
    senderName: '李四',
    group: { id: 'group_1', name: '测试群' },
  });
  assert.ok(await waitFor(() => agents.created.length === 1));
  const agent = agents.created[0].agent;
  assert.ok(await waitFor(() => agent.followedUp.length === 1));
  assert.equal(agent.followedUp[0].content[0].text, '[李四 (wxid_b)] 群里提问');

  gateway.onSessionEvent(agent.session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '收到' }] } },
  });
  assert.ok(await waitFor(() => hub.replies.length === 1));
  assert.equal(hub.replies[0].to, 'group_1');

  await gateway.dispose();
  await hub.close();
});

test('访问控制 allow 模式拒绝非白名单发送者', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url, access: { mode: 'allow', allow: ['wxid_ok'] } }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({ text: '陌生人', senderId: 'wxid_bad' });
  hub.pushMessage({ text: '自己人', senderId: 'wxid_ok' });

  assert.ok(await waitFor(() => agents.created.length === 1));
  const agent = agents.created[0].agent;
  assert.ok(await waitFor(() => agent.followedUp.length === 1));
  assert.equal(agent.followedUp[0].content[0].text, '自己人');

  await gateway.dispose();
  await hub.close();
});

test('长回复按 textChunkLimit 切分成多条', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url, textChunkLimit: 20 }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({ text: 'hi', senderId: 'wxid_c' });
  assert.ok(await waitFor(() => agents.created.length === 1));
  const agent = agents.created[0].agent;

  const long = Array.from({ length: 10 }, (_, i) => `行-${i}`).join('\n');
  gateway.onSessionEvent(agent.session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: long }] } },
  });

  assert.ok(await waitFor(() => hub.replies.length >= 2), '应切成多条发送');
  const joined = hub.replies.map((reply) => reply.content).join('\n');
  assert.equal(joined.replace(/\n+/g, '\n'), long.replace(/\n+/g, '\n'));

  await gateway.dispose();
  await hub.close();
});

test('turn/end 错误回传给用户', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({ text: 'hi', senderId: 'wxid_d' });
  assert.ok(await waitFor(() => agents.created.length === 1));
  const agent = agents.created[0].agent;

  gateway.onSessionEvent(agent.session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '太频繁' } } },
  });
  assert.ok(await waitFor(() => hub.replies.length === 1));
  assert.match(hub.replies[0].content, /RATE_LIMIT/);
  assert.match(hub.replies[0].content, /太频繁/);

  await gateway.dispose();
  await hub.close();
});

test('断线后自动重连并恢复收消息', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.reconnectDelay = 50;
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  // 服务端主动断开全部连接。
  for (const client of hub.clients) client.close();
  assert.ok(await waitFor(() => gateway.connectionState !== 'connected'), '应观察到断开');

  assert.ok(await waitFor(() => gateway.connectionState === 'connected', { timeout: 5000 }), '应自动重连');

  hub.pushMessage({ text: '重连之后', senderId: 'wxid_e' });
  assert.ok(await waitFor(() => agents.created.length === 1));
  const agent = agents.created[0].agent;
  assert.ok(await waitFor(() => agent.followedUp.length === 1));
  assert.equal(agent.followedUp[0].content[0].text, '重连之后');

  await gateway.dispose();
  await hub.close();
});

test('dispose 关闭连接并取消会话', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));
  hub.pushMessage({ text: 'hi', senderId: 'wxid_f' });
  assert.ok(await waitFor(() => agents.created.length === 1));
  const agent = agents.created[0].agent;

  await gateway.dispose();
  assert.equal(gateway.connectionState, 'stopped');
  assert.deepEqual(agent.cancelled, { kind: 'disposed' });
  assert.ok(await waitFor(() => hub.clients.size === 0), '连接应关闭');

  await hub.close();
});

test('未配置时不连接，状态为 unconfigured', async () => {
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: '', appToken: '' }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.equal(gateway.connectionState, 'unconfigured');
  assert.equal(gateway.status().configured, false);
  await gateway.dispose();
});

test('/new 命令轮换会话并释放旧 Agent', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({ text: 'hi', senderId: 'wxid_new' });
  assert.ok(await waitFor(() => agents.created.length === 1));
  const firstAgent = agents.created[0].agent;

  hub.pushMessage({ text: '/new', senderId: 'wxid_new' });
  assert.ok(await waitFor(() => hub.replies.length === 1));
  assert.equal(hub.replies[0].content, '已开始新会话。');
  assert.deepEqual(firstAgent.cancelled, { kind: 'user' });
  assert.equal(firstAgent.followedUp.length, 1, '/new 不应进入模型上下文');

  hub.pushMessage({ text: '第二条', senderId: 'wxid_new' });
  assert.ok(await waitFor(() => agents.created.length === 2), '应在新会话里处理');
  assert.notEqual(agents.created[0].options.sessionId, agents.created[1].options.sessionId);

  await gateway.dispose();
  await hub.close();
});

test('同一 peer 的消息串行处理，不交错', async () => {
  const hub = await startMockHub().listen();
  const order = [];
  const agents = {
    created: [],
    get: () => undefined,
    async create(options) {
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      const agent = {
        session: { id: options.sessionId },
        async followup(message) {
          order.push(`start:${message.content[0].text}`);
          await gate;
          order.push(`end:${message.content[0].text}`);
        },
        cancel() {},
        async whenIdle() {
          release();
        },
      };
      this.created.push({ options, agent });
      return { agent, dispose: async () => {} };
    },
    async resume() {
      throw new Error('none');
    },
  };
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({ text: 'A', senderId: 'wxid_q' });
  hub.pushMessage({ text: 'B', senderId: 'wxid_q' });

  assert.ok(await waitFor(() => order.length === 4, { timeout: 5000 }));
  assert.deepEqual(order, ['start:A', 'end:A', 'start:B', 'end:B']);

  await gateway.dispose();
  await hub.close();
});

test('闲置会话被回收，下一条消息重新建立', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({ text: 'hi', senderId: 'wxid_idle' });
  assert.ok(await waitFor(() => agents.created.length === 1));
  assert.equal(gateway.status().sessions.length, 1);

  // 把最后活动时间推到很久以前，再手动清扫。
  for (const record of gateway.live.values()) record.lastActivity = Date.now() - 10 * 60_000;
  await gateway.sweepIdle(60_000);
  assert.equal(gateway.status().sessions.length, 0);

  await gateway.dispose();
  await hub.close();
});

test('助手消息里的思考与正文都会发到微信', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({ text: 'hi', senderId: 'wxid_r' });
  assert.ok(await waitFor(() => agents.created.length === 1));
  const agent = agents.created[0].agent;

  gateway.onSessionEvent(agent.session, {
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: '用户只是打招呼' },
          { type: 'text', text: '你好呀' },
        ],
      },
    },
  });

  assert.ok(await waitFor(() => hub.replies.length === 2), '思考与正文应各发一条');
  assert.match(hub.replies[0].content, /🧠 思考/);
  assert.match(hub.replies[0].content, /用户只是打招呼/);
  assert.equal(hub.replies[1].content, '你好呀');

  await gateway.dispose();
  await hub.close();
});

test('showReasoning=false 时不发思考，只发正文', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url, showReasoning: false }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({ text: 'hi', senderId: 'wxid_nr' });
  assert.ok(await waitFor(() => agents.created.length === 1));
  const agent = agents.created[0].agent;

  gateway.onSessionEvent(agent.session, {
    type: 'assistant/message',
    data: {
      message: {
        content: [
          { type: 'reasoning', text: '内部推理' },
          { type: 'text', text: '可见回复' },
        ],
      },
    },
  });

  assert.ok(await waitFor(() => hub.replies.length === 1));
  assert.equal(hub.replies[0].content, '可见回复');

  await gateway.dispose();
  await hub.close();
});

test('工具调用与结果都会发到微信', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({ text: '看看目录', senderId: 'wxid_t' });
  assert.ok(await waitFor(() => agents.created.length === 1));
  const agent = agents.created[0].agent;

  gateway.onSessionEvent(agent.session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
  });
  gateway.onSessionEvent(agent.session, {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'a.txt' }] },
    },
  });

  assert.ok(await waitFor(() => hub.replies.length === 2), '调用与结果应各发一条');
  assert.match(hub.replies[0].content, /🔧 调用 `bash`/);
  assert.match(hub.replies[0].content, /command/);
  assert.match(hub.replies[1].content, /✅ 完成 `bash`/);
  assert.match(hub.replies[1].content, /a\.txt/);

  await gateway.dispose();
  await hub.close();
});

test('showTools=false 时不发工具使用', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url, showTools: false }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({ text: '看看目录', senderId: 'wxid_nt' });
  assert.ok(await waitFor(() => agents.created.length === 1));
  const agent = agents.created[0].agent;

  gateway.onSessionEvent(agent.session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'call-2', name: 'bash', arguments: '{"command":"ls"}' },
  });
  gateway.onSessionEvent(agent.session, {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'call-2' }, content: [{ type: 'text', text: 'a.txt' }] },
    },
  });

  await delay(150);
  assert.equal(hub.replies.length, 0, '关闭后不应发送工具消息');

  await gateway.dispose();
  await hub.close();
});

test('/model 命令切换模型后，下一条消息按新路由建会话', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({ text: 'hi', senderId: 'wxid_m' });
  assert.ok(await waitFor(() => agents.created.length === 1));
  assert.equal(agents.created[0].options.agentOptions.provider, 'p');

  hub.pushMessage({ text: '/model deepseek/deepseek-chat', senderId: 'wxid_m' });
  assert.ok(await waitFor(() => hub.replies.length === 1));
  assert.match(hub.replies[0].content, /模型已切换：deepseek\/deepseek-chat/);
  assert.equal(agents.created[0].agent.followedUp.length, 1, '/model 不应进入模型上下文');

  hub.pushMessage({ text: '再来一条', senderId: 'wxid_m' });
  assert.ok(await waitFor(() => agents.created.length === 2), '应重建会话以应用新路由');
  assert.equal(agents.created[1].options.agentOptions.provider, 'deepseek');
  assert.equal(agents.created[1].options.agentOptions.model, 'deepseek-chat');
  assert.equal(agents.created[1].options.sessionId, agents.created[0].options.sessionId, '会话 id 不变，历史保留');

  await gateway.dispose();
  await hub.close();
});

test('/model reset 恢复插件默认路由', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  await gateway.setModelOverride('bot-1', 'direct', 'wxid_rst', { provider: 'x', model: 'y' });
  hub.pushMessage({ text: '/model reset', senderId: 'wxid_rst' });
  assert.ok(await waitFor(() => hub.replies.length === 1));
  assert.match(hub.replies[0].content, /已恢复默认模型/);

  hub.pushMessage({ text: 'hi', senderId: 'wxid_rst' });
  assert.ok(await waitFor(() => agents.created.length === 1));
  assert.equal(agents.created[0].options.agentOptions.provider, 'p');

  await gateway.dispose();
  await hub.close();
});

test('/model 在群聊里也能识别（剥掉发送者标签）', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({
    text: '/model deepseek/deepseek-chat',
    senderId: 'wxid_g',
    senderName: '王五',
    group: { id: 'group_m', name: '测试群' },
  });
  assert.ok(await waitFor(() => hub.replies.length === 1));
  assert.match(hub.replies[0].content, /模型已切换/);
  assert.equal(hub.replies[0].to, 'group_m');
  assert.equal(agents.created.length, 0, '命令不应创建会话');

  await gateway.dispose();
  await hub.close();
});

// ── 频道形态的会话 id ─────────────────────────────────────────────
//
// 插件把会话 id 派生为 `im:weixin_openilink_<bot>:<dm|group>:<peer>`，
// 让装了 IM Connect 的网页把会话归进「频道 → 微信」。这里锁定建会话时
// 真正传给 Host 的 id 形态，避免以后改派生逻辑时悄悄回退成 UUID。

test('建会话时使用 IM Connect 频道约定的会话 id', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({ text: '私聊', senderId: 'wxid_dm@im.wechat' });
  hub.pushMessage({ text: '群聊', senderId: 'wxid_g', group: { id: '123@chatroom', name: '测试群' } });

  assert.ok(await waitFor(() => agents.created.length === 2));
  const ids = agents.created.map((item) => item.options.sessionId).sort();
  const instance = channelInstance('bot-1');
  assert.deepEqual(ids, [
    `im:${instance}:dm:wxid_dm@im.wechat`,
    `im:${instance}:group:123@chatroom`,
  ].sort());

  // 平台前缀必须是 im-connect 已知的渠道，否则会话会被丢弃而不是进频道。
  for (const id of ids) {
    const [channel, kind, chatId] = id.slice('im:'.length).split(':');
    assert.equal(channel.split('_')[0], 'weixin');
    assert.match(channel, /^[a-z0-9_-]+$/);
    assert.ok(kind === 'dm' || kind === 'group');
    assert.notEqual(chatId, '');
  }

  await gateway.dispose();
  await hub.close();
});

test('/new 之后会话 id 带时间戳分段，且仍能被剥离回同一 peer', async () => {
  const hub = await startMockHub().listen();
  const agents = fakeAgents();
  const gateway = new OpeniLinkGateway({
    ctx: makeContext(agents),
    config: makeConfig({ hubUrl: hub.url }),
    logger: silentLogger,
  });
  gateway.connect();
  assert.ok(await waitFor(() => gateway.connectionState === 'connected'));

  hub.pushMessage({ text: 'hi', senderId: 'wxid_n' });
  assert.ok(await waitFor(() => agents.created.length === 1));
  hub.pushMessage({ text: '/new', senderId: 'wxid_n' });
  assert.ok(await waitFor(() => hub.replies.length === 1));
  hub.pushMessage({ text: '第二条', senderId: 'wxid_n' });
  assert.ok(await waitFor(() => agents.created.length === 2));

  const rotatedId = agents.created[1].options.sessionId;
  const [channel, kind, stamp, ...rest] = rotatedId.slice('im:'.length).split(':');
  assert.equal(channel, channelInstance('bot-1'));
  assert.equal(kind, 'dm');
  assert.match(stamp, /^\d{13,}$/, '轮换 id 的时间戳段应是纯数字，im-connect 才会剥离');
  assert.equal(rest.join(':'), 'wxid_n', '剥离后 chatId 仍是 peer');

  await gateway.dispose();
  await hub.close();
});
