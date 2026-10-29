/**
 * OpeniLink 通道的 Host 服务：连接、会话、出入站。
 *
 * 设计要点（与 @tencent-connect/dsh-qqbot 同构，便于本仓维护者对照）：
 * - 每个安装实例一条 WebSocket；断线指数退避重连，插件卸载时立即停止。
 * - 入站消息 → 找/建 dsh Agent 会话 → followup 一条 user/message。
 * - 出站直接监听 `session/event`，把 assistant/message 的文本发回 Hub。
 * - 会话与 Agent 的生命周期都挂在插件 fiber 上：卸载即释放，不留悬挂连接。
 *
 * @module dsh-openilink-channel/gateway
 */
import { randomUUID } from 'node:crypto';
import { HubClient, describeFetchError, normalizeHubUrl, renderItems, splitText, websocketUrl } from './hub.js';
import { imageItems, ingestImages } from './media.js';
import { SessionRegistry } from './sessions.js';

/** 重连退避上限。 */
const MAX_RECONNECT_DELAY_MS = 60_000;
/** 初始重连间隔。 */
const INITIAL_RECONNECT_DELAY_MS = 1_000;
/** 心跳间隔：Hub 侧以 pong 回应，用于尽早发现半开连接。 */
const PING_INTERVAL_MS = 30_000;
/** 闲置会话清扫间隔。 */
const IDLE_SWEEP_INTERVAL_MS = 60_000;

/** 不展示给用户的轮次错误码（底层传输抖动，对用户无意义）。 */
const SILENT_TURN_ERROR_CODES = new Set(['STREAM_CLOSED']);

/** 工具调用参数在消息里的最大展示长度。 */
const TOOL_ARGS_PREVIEW_LIMIT = 300;
/** 工具结果在消息里的最大展示长度。 */
const TOOL_RESULT_PREVIEW_LIMIT = 1200;
/** 思考块前缀。 */
export const REASONING_PREFIX = '🧠 思考';
/** 工具调用前缀。 */
export const TOOL_CALL_PREFIX = '🔧 调用';
/** 工具完成前缀。 */
export const TOOL_DONE_PREFIX = '✅ 完成';
/** 工具失败前缀。 */
export const TOOL_FAILED_PREFIX = '⚠️ 失败';

/**
 * 访问控制：open = 都放行；allow = 仅白名单。
 *
 * @param {{ mode: string, allow: readonly string[] }} access
 * @param {string} senderId
 * @returns {boolean}
 */
export function isAllowed(access, senderId) {
  if (access.mode !== 'allow') return true;
  return access.allow.includes(senderId);
}

/**
 * 把一条 Hub 事件整理成模型可见的正文。
 *
 * 私聊直接给正文；群聊在正文前加发送者标签，让模型知道是谁在说话。
 *
 * @param {object} eventData 事件 data
 * @param {'direct'|'group'} kind
 * @returns {string}
 */
export function composeBody(eventData, kind) {
  const body = renderItems(eventData?.content, eventData?.msg_type, eventData?.items).trim();
  if (kind !== 'group') return body;
  const sender = eventData?.sender;
  const name = sender?.name || sender?.id || 'unknown';
  const id = sender?.id ? ` (${sender.id})` : '';
  return body === '' ? `[${name}${id}]` : `[${name}${id}] ${body}`;
}

/** 读取一条事件的 trace id 兜底（Hub 事件一定有 trace_id，缺失时生成）。 */
function traceOf(envelope) {
  return typeof envelope?.trace_id === 'string' && envelope.trace_id !== '' ? envelope.trace_id : undefined;
}

/** 群聊正文前缀 `[昵称 (id)] ` 的正则。 */
const SENDER_TAG = /^\[[^\]]*\]\s*/;

/** 去掉群聊的发送者标签（命令识别用）。 */
export function stripSenderTag(body) {
  return String(body ?? '').replace(SENDER_TAG, '').trim();
}

/** 归一化成命令串（小写、去标签、只取首行）。 */
export function commandOf(body) {
  const first = stripSenderTag(body).split('\n', 1)[0] ?? '';
  return first.trim().toLowerCase();
}

/**
 * 通道运行时：一条 WebSocket + 一组会话。
 */
export class OpeniLinkGateway {
  /**
   * @param {{
   *   ctx: any,
   *   config: any,
   *   logger: { info: Function, warn: Function, error: Function, debug: Function },
   * }} options
   */
  constructor(options) {
    this.ctx = options.ctx;
    this.config = options.config;
    this.logger = options.logger;

    this.hubUrl = normalizeHubUrl(this.config.hubUrl || process.env.OPENILINK_HUB_URL || '');
    this.appToken = String(this.config.appToken || process.env.OPENILINK_APP_TOKEN || '');
    this.client = new HubClient({ hubUrl: this.hubUrl, appToken: this.appToken });

    this.registry = new SessionRegistry({ logger: this.logger });
    /** @type {Map<string, { agent: any, handle: any, kind: 'direct'|'group', peerId: string, lastActivity: number }>} */
    this.live = new Map();
    /** @type {WebSocket | undefined} */
    this.socket = undefined;
    this.stopped = false;
    this.reconnectTimer = undefined;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    this.pingTimer = undefined;
    this.connectionState = this.client.configured ? 'idle' : 'unconfigured';
    this.lastError = undefined;
    /** 最近一次从 Hub 收到的事件时间（用于状态页展示）。 */
    this.lastEventAt = undefined;
    /** 每个会话最近一次的回复目标，用于出站。 */
    this.replyTargets = new Map();
    /** callId → { name, arguments }：给工具结果补上工具名。 */
    this.toolCalls = new Map();
    /** peer key → 会话级模型覆盖（`/model` 设置）。 */
    this.modelOverrides = new Map();
    /** 每 peer 一条串行链，保证同一会话的消息按到达顺序处理。 */
    this.queues = new Map();
    this.idleTimer = undefined;
  }

  /** 当前连接状态快照（状态页与工具共用）。 */
  status() {
    return {
      configured: this.client.configured,
      state: this.connectionState,
      hubUrl: this.hubUrl,
      lastError: this.lastError,
      lastEventAt: this.lastEventAt,
      sessions: [...this.live.entries()].map(([key, record]) => ({
        key,
        kind: record.kind,
        peerId: record.peerId,
        sessionId: record.agent?.session?.id,
        lastActivity: record.lastActivity,
      })),
    };
  }

  // ── 连接 ────────────────────────────────────────────────────────

  /** 建立（或重建）WebSocket 连接；重复调用无副作用。 */
  connect() {
    if (this.stopped) return;
    if (!this.client.configured) {
      this.connectionState = 'unconfigured';
      return;
    }
    if (this.socket !== undefined) {
      const state = this.socket.readyState;
      if (state === 0 || state === 1) return;
    }

    let url;
    try {
      url = websocketUrl(this.hubUrl, this.appToken);
    } catch (error) {
      this.connectionState = 'error';
      this.lastError = String(error);
      return;
    }

    this.connectionState = 'connecting';
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.connectionState = 'error';
      this.lastError = String(error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.connectionState = 'connected';
      this.lastError = undefined;
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.logger.info(`[openilink] 已连接 Hub：${this.hubUrl}`);
      this.startPing();
    });

    socket.addEventListener('message', (message) => {
      this.handleMessage(message.data);
    });

    socket.addEventListener('close', (event) => {
      this.stopPing();
      if (this.socket === socket) this.socket = undefined;
      if (this.stopped) {
        this.connectionState = 'stopped';
        return;
      }
      this.connectionState = 'disconnected';
      if (event?.code) this.lastError = `连接关闭（code=${event.code}${event.reason ? ` ${event.reason}` : ''}）`;
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // WebSocket 的 error 事件不带可用细节，close 事件会紧随其后。
      this.lastError = 'WebSocket 连接出错';
      this.connectionState = 'error';
    });
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.socket?.readyState === 1) {
        try {
          this.socket.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // 发送失败由 close 事件处理。
        }
      }
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  stopPing() {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const delay = this.reconnectDelay + Math.floor(Math.random() * 500);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
  /** 停止连接与全部会话（插件卸载时调用）。 */
  async dispose() {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.idleTimer !== undefined) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.stopPing();
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      try {
        socket.close(1000, 'plugin disposed');
      } catch {
        // 已经关闭。
      }
    }
    this.queues.clear();
    const records = [...this.live.values()];
    this.live.clear();
    this.replyTargets.clear();
    this.toolCalls.clear();
    this.modelOverrides.clear();
    this.registry.clear();
    for (const record of records) {
      try {
        record.agent?.cancel?.({ kind: 'disposed' });
      } catch {
        // ignore
      }
      try {
        await record.handle?.dispose?.();
      } catch {
        // 卸载期的清理失败不应阻塞其它会话。
      }
    }
    this.connectionState = 'stopped';
  }

  /**
   * 启动闲置会话清扫：超过 sessionIdleMinutes 未活动的会话被释放
   * （会话日志保留在磁盘，下一条消息会 resume 回来）。
   */
  startIdleSweep() {
    const minutes = Number(this.config.sessionIdleMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    if (this.idleTimer !== undefined) return;
    const ttl = minutes * 60_000;
    this.idleTimer = setInterval(() => {
      void this.sweepIdle(ttl);
    }, Math.min(IDLE_SWEEP_INTERVAL_MS, ttl));
    this.idleTimer.unref?.();
  }

  /** 释放闲置超时的会话。 */
  async sweepIdle(ttl) {
    if (this.stopped) return;
    const now = Date.now();
    const expired = [...this.live.entries()].filter(([, record]) => now - record.lastActivity > ttl);
    for (const [key, record] of expired) {
      if (record.agent?.status === 'running') continue;
      this.live.delete(key);
      this.logger.info(`[openilink] 回收闲置会话：${key}`);
      try {
        record.agent?.cancel?.({ kind: 'user' });
      } catch {
        // ignore
      }
      try {
        await record.handle?.dispose?.();
      } catch {
        // ignore
      }
    }
  }

  // ── 入站 ────────────────────────────────────────────────────────

  handleMessage(raw) {
    let envelope;
    try {
      envelope = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch (error) {
      this.logger.warn(`[openilink] 无法解析 Hub 消息：${describeFetchError(error)}`);
      return;
    }
    if (envelope === null || typeof envelope !== 'object') return;

    switch (envelope.type) {
      case 'init':
        this.logger.info(
          `[openilink] 已就绪：bot=${envelope.data?.bot_id ?? '?'} app=${envelope.data?.app_slug ?? '?'}`,
        );
        return;
      case 'pong':
        return;
      case 'ack':
        if (envelope.ok === false) this.logger.warn(`[openilink] Hub 拒绝请求：${envelope.error ?? 'unknown'}`);
        return;
      case 'error':
        this.lastError = String(envelope.error ?? 'Hub 返回错误');
        this.logger.warn(`[openilink] Hub 错误：${this.lastError}`);
        return;
      case 'event':
        void this.handleEvent(envelope);
        return;
      default:
        this.logger.debug?.(`[openilink] 忽略未知消息类型：${String(envelope.type)}`);
    }
  }

  async handleEvent(envelope) {
    const event = envelope.event;
    if (event === null || typeof event !== 'object') return;
    if (event.type !== 'message.text' && !String(event.type ?? '').startsWith('message.')) return;

    const data = event.data ?? {};
    const senderId = String(data.sender?.id ?? 'unknown');
    const senderName = data.sender?.name ? String(data.sender.name) : senderId;
    const groupId = data.group?.id ? String(data.group.id) : '';
    const kind = groupId !== '' ? 'group' : 'direct';
    const peerId = kind === 'group' ? groupId : senderId;
    const botId = String(envelope.bot?.id ?? envelope.installation_id ?? 'unknown');

    if (!isAllowed(this.config.access, senderId)) {
      this.logger.info(`[openilink] 拒绝未授权发送者：${senderId}`);
      return;
    }

    const body = composeBody(data, kind);
    if (body.trim() === '') return;

    this.lastEventAt = Date.now();
    const traceId = traceOf(envelope);
    const replyTarget = { botId, kind, peerId, traceId, senderName };

    // 同一 peer 串行处理：后一条消息不会打断前一条的回合。
    const queueKey = `${botId}:${kind}:${peerId}`;
    const previous = this.queues.get(queueKey) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.processEvent({ botId, kind, peerId, senderId, senderName, body, data, traceId, replyTarget }));
    this.queues.set(queueKey, current);
    try {
      await current;
    } finally {
      if (this.queues.get(queueKey) === current) this.queues.delete(queueKey);
    }
  }

  /** 真正处理一条消息：建会话、注入、等收敛。 */
  async processEvent({ botId, kind, peerId, senderName, body, data, traceId, replyTarget }) {
    if (this.stopped) return;

    // 会话控制命令：不进入模型上下文。
    // 群聊正文前有 `[昵称 (id)]` 标签，识别命令前先剥掉。
    const command = commandOf(body);
    if (command === '/new' || command === '/reset') {
      this.registry.rotate(botId, kind, peerId);
      const old = this.live.get(`${botId}:${kind}:${peerId}`);
      if (old !== undefined) {
        this.live.delete(`${botId}:${kind}:${peerId}`);
        try {
          old.agent?.cancel?.({ kind: 'user' });
          await old.handle?.dispose?.();
        } catch {
          // ignore
        }
      }
      await this.sendText(peerId, '已开始新会话。', traceId);
      return;
    }
    if (command === '/model' || command.startsWith('/model ')) {
      await this.handleModelCommand({ botId, kind, peerId, body: stripSenderTag(body), traceId });
      return;
    }

    let record;
    try {
      record = await this.ensureSession(botId, kind, peerId);
    } catch (error) {
      this.logger.error(`[openilink] 创建会话失败：${describeFetchError(error)}`);
      await this.sendText(peerId, '⚠️ 无法启动本地助手会话，请查看 Harness 日志。', traceId);
      return;
    }

    record.lastActivity = Date.now();
    record.senderName = senderName;
    this.replyTargets.set(`${botId}:${kind}:${peerId}`, replyTarget);

    try {
      const message = await this.createUserMessage(body, data);
      record.agent.followup(message);
      this.logger.info(`[openilink] ← ${kind}:${peerId} ${body.slice(0, 120)}`);
    } catch (error) {
      this.logger.error(`[openilink] 注入消息失败：${describeFetchError(error)}`);
      await this.sendText(peerId, '⚠️ 消息未能交给助手处理，请稍后重试。', traceId);
      return;
    }

    // 等本轮收敛再返回，避免同一 peer 的连续消息互相打断。
    try {
      await record.agent.whenIdle();
    } catch {
      // whenIdle 在取消/卸载时可能 reject，不影响后续消息。
    }
  }

  /**
   * `/model` 命令：查看或切换当前聊天的模型。
   *
   * - `/model`               → 显示当前路由、插件配置与可用模型
   * - `/model provider/model`→ 切换（provider 省略时沿用当前 provider）
   * - `/model reset`         → 清除本聊天的覆盖，回到插件/宿主默认
   *
   * @param {{ botId: string, kind: 'direct'|'group', peerId: string, body: string, traceId?: string }} args
   */
  async handleModelCommand({ botId, kind, peerId, body, traceId }) {
    const raw = body.trim().slice('/model'.length).trim();
    const override = this.modelOverrideFor(botId, kind, peerId);
    const fallback = this.resolveAgentOptions(override);

    if (raw === '') {
      const current = fallback ? `${fallback.provider}/${fallback.model}` : '宿主默认配置';
      const source = override !== undefined ? '（本聊天覆盖）' : this.config.provider && this.config.model ? '（插件配置）' : '（宿主默认）';
      const lines = [`🤖 当前模型：${current}${source}`];
      const configured = this.config.provider && this.config.model ? `${this.config.provider}/${this.config.model}` : '未配置（继承宿主）';
      lines.push(`插件配置：${configured}`);
      const models = await this.listAvailableModels();
      if (models.length > 0) {
        lines.push('', '可用模型：');
        for (const model of models.slice(0, 20)) lines.push(`- ${model.provider}/${model.id}`);
      }
      lines.push('', '切换：/model provider/model', '清除覆盖：/model reset');
      await this.sendText(peerId, lines.join('\n'), traceId);
      return;
    }

    if (raw.toLowerCase() === 'reset') {
      await this.setModelOverride(botId, kind, peerId, undefined);
      const next = this.resolveAgentOptions();
      const current = next ? `${next.provider}/${next.model}` : '宿主默认配置';
      await this.sendText(peerId, `✅ 已恢复默认模型：${current}`, traceId);
      return;
    }

    let provider;
    let model;
    if (raw.includes('/')) {
      const index = raw.indexOf('/');
      provider = raw.slice(0, index).trim();
      model = raw.slice(index + 1).trim();
    } else {
      provider = fallback?.provider ?? '';
      model = raw;
    }
    if (provider === '' || model === '') {
      await this.sendText(peerId, '用法：/model provider/model\n例如：/model deepseek/deepseek-chat', traceId);
      return;
    }

    await this.setModelOverride(botId, kind, peerId, {
      provider,
      model,
      ...(this.config.reasoningEffort ? { reasoningEffort: this.config.reasoningEffort } : {}),
    });
    await this.sendText(peerId, `✅ 模型已切换：${provider}/${model}\n下一条消息生效，对话上下文保留。`, traceId);
  }

  /** 列出宿主已注册的 provider 与模型（失败时返回空列表）。 */
  async listAvailableModels() {
    let llm;
    try {
      llm = this.ctx.get?.('llm');
    } catch {
      llm = undefined;
    }
    if (llm === undefined || llm === null) return [];
    const out = [];
    let providers = [];
    try {
      providers = llm.listProviders?.() ?? [];
    } catch {
      return [];
    }
    for (const provider of providers) {
      try {
        const models = await llm.listModels?.(provider.id);
        for (const model of models ?? []) out.push({ provider: String(provider.id), id: String(model.id) });
      } catch {
        // 单个 provider 失败不影响其它。
      }
    }
    return out;
  }

  /**
   * 构造一条 user/message。
   *
   * 图片项会尽力下载并作为附件提交，让视觉模型直接看到图；
   * 下载失败或非图片时退回文本（保留 URL，模型可自行取用）。   *
   * @param {string} body
   * @param {object} eventData
   * @returns {Promise<any>}
   */
  async createUserMessage(body, eventData) {
    const content = [];
    const images = this.config.media?.enabled === false ? [] : imageItems(eventData?.items);
    if (images.length > 0) {
      let attachments;
      try {
        attachments = this.ctx.get?.('attachments');
      } catch {
        attachments = undefined;
      }
      if (attachments !== undefined && attachments !== null) {
        const blocks = await ingestImages(
          {
            attachments,
            appToken: this.appToken,
            maxBytes: (this.config.media?.maxMB ?? 30) * 1024 * 1024,
            logger: this.logger,
          },
          images,
        );
        content.push(...blocks);
      }
    }
    content.push({ type: 'text', text: body });
    return createUserMessageSafely(content);
  }

  // ── 会话 ────────────────────────────────────────────────────────

  async ensureSession(botId, kind, peerId) {
    const identity = this.registry.identity(botId, kind, peerId);
    const existing = this.live.get(identity.key);
    if (existing !== undefined) return existing;

    const sessionId = identity.sessionId;
    const agents = this.ctx.agents;
    let agent;
    let handle;

    const liveAgent = agents.get(sessionId);
    if (liveAgent !== undefined) {
      agent = liveAgent;
      handle = { agent, dispose: async () => {} };
    } else {
      const setup = await this.presetSetup();
      const agentOptions = this.resolveAgentOptions(this.modelOverrideFor(botId, kind, peerId));
      try {
        const resumed = await agents.resume({
          resumeSessionId: sessionId,
          ...(agentOptions ? { agentOptions } : {}),
          ...(setup ? { setup } : {}),
        });
        agent = resumed.agent;
        handle = resumed;
        this.logger.info(`[openilink] 恢复会话 ${sessionId}`);
      } catch (error) {
        this.logger.debug?.(`[openilink] 会话不存在，新建：${sessionId}`);
        const created = await agents.create({
          sessionId,
          meta: {
            cwd: this.config.cwd || process.cwd(),
            ...(this.config.agentPreset ? { agentPreset: this.config.agentPreset } : {}),
          },
          ...(agentOptions ? { agentOptions } : {}),
          ...(setup ? { setup } : {}),
        });
        agent = created.agent;
        handle = created;
        this.logger.info(`[openilink] 新建会话 ${sessionId}`);
      }
    }

    const record = { agent, handle, botId, kind, peerId, lastActivity: Date.now() };
    this.live.set(identity.key, record);
    return record;
  }

  /** 读取某个 peer 的模型覆盖（`/model` 切换的结果）。 */
  modelOverrideFor(botId, kind, peerId) {
    return this.modelOverrides.get(`${botId}:${kind}:${peerId}`);
  }

  /**
   * 设置（或清除）某个 peer 的模型覆盖。
   *
   * 覆盖只在建会话/恢复会话时生效，因此这里同时释放已存在的 Agent：
   * 下一条消息会以新的路由 resume 同一个会话，历史上下文保留。
   *
   * @param {string} botId
   * @param {'direct'|'group'} kind
   * @param {string} peerId
   * @param {{ provider: string, model: string, reasoningEffort?: string } | undefined} selection
   */
  async setModelOverride(botId, kind, peerId, selection) {
    const key = `${botId}:${kind}:${peerId}`;
    if (selection === undefined) this.modelOverrides.delete(key);
    else this.modelOverrides.set(key, selection);

    const record = this.live.get(key);
    if (record === undefined) return;
    this.live.delete(key);
    try {
      record.agent?.cancel?.({ kind: 'user' });
    } catch {
      // ignore
    }
    try {
      await record.handle?.dispose?.();
    } catch {
      // ignore
    }
  }

  /**
   * 解析模型路由：配置优先，否则沿用宿主默认模型。
   *
   * @param {{ provider?: string, model?: string, reasoningEffort?: string }} [override]
   *   会话级覆盖（`/model` 切换时传入），优先级高于插件配置。
   */
  resolveAgentOptions(override) {
    const pick = (provider, model, reasoningEffort) => ({
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    if (override?.provider && override?.model) {
      return pick(override.provider, override.model, override.reasoningEffort);
    }
    const configured = this.config;
    if (configured.provider && configured.model) {
      return pick(configured.provider, configured.model, configured.reasoningEffort);
    }
    try {
      const selection = this.ctx.get?.('agentDefaultModel')?.currentSelection?.();
      if (selection?.provider && selection?.model) {
        return pick(selection.provider, selection.model, selection.reasoningEffort);
      }
    } catch {
      // 服务缺失时退回宿主默认路由。
    }
    return undefined;
  }

  /** 挂载 agent preset（配置了才挂；未配置时沿用宿主组合）。 */
  async presetSetup() {
    const preset = this.config.agentPreset;
    if (!preset) return undefined;
    let presets;
    try {
      presets = this.ctx.get?.('agentPresets');
    } catch {
      presets = undefined;
    }
    if (presets === undefined || presets === null) return undefined;
    try {
      const resolved = await presets.resolve(preset);
      return async (agentCtx) => {
        await presets.mount(agentCtx, resolved.id);
      };
    } catch (error) {
      this.logger.warn(`[openilink] preset ${preset} 不可用：${describeFetchError(error)}`);
      return undefined;
    }
  }

  // ── 出站 ────────────────────────────────────────────────────────

  /**
   * session/event 监听器：把助手回复、思考过程与工具使用发回 Hub。
   *
   * 一个回合里模型可能产生多条 assistant/message（每次工具调用前后各一条），
   * 因此这里按事件逐条转发：先发 reasoning（🧠 思考），再发正文；
   * 工具调用与结果分别由 `tool/call` / `tool/result` 事件转发。
   *
   * @param {any} session
   * @param {any} event
   */
  onSessionEvent(session, event) {
    const type = event?.type;
    if (type === 'tool/call') {
      const record = this.findBySessionId(session?.header?.id ?? session?.id);
      if (record === undefined) return;
      const data = event.data ?? {};
      const callId = data.callId === undefined ? undefined : String(data.callId);
      if (callId !== undefined) this.toolCalls.set(callId, { name: String(data.name ?? '?'), args: data.arguments });
      if (this.showTools() === false) return;
      const target = this.replyTargets.get(`${record.botId}:${record.kind}:${record.peerId}`);
      void this.sendText(record.peerId, toolCallText(data.name, data.arguments), target?.traceId);
      return;
    }

    if (type === 'tool/result') {
      const record = this.findBySessionId(session?.header?.id ?? session?.id);
      if (record === undefined) return;
      const data = event.data ?? {};
      const callId = data?.message?.source?.callId ?? data.callId;
      const known = callId === undefined ? undefined : this.toolCalls.get(String(callId));
      if (callId !== undefined) this.toolCalls.delete(String(callId));
      if (this.showTools() === false) return;
      const target = this.replyTargets.get(`${record.botId}:${record.kind}:${record.peerId}`);
      void this.sendText(record.peerId, toolResultText(known?.name, data), target?.traceId);
      return;
    }

    if (type === 'assistant/message') {
      const message = event.data?.message;
      const text = assistantText(message);
      const reasoning = assistantReasoning(message);
      if (text === '' && reasoning === '') return;
      const record = this.findBySessionId(session?.header?.id ?? session?.id);
      if (record === undefined) return;
      const target = this.replyTargets.get(`${record.botId}:${record.kind}:${record.peerId}`);
      if (reasoning !== '' && this.showReasoning()) {
        void this.sendText(record.peerId, `${REASONING_PREFIX}\n${reasoning}`, target?.traceId);
      }
      if (text !== '') void this.sendText(record.peerId, text, target?.traceId);
      return;
    }

    if (type === 'turn/end') {
      const failure = turnFailure(event.data?.reason);
      if (failure === undefined || SILENT_TURN_ERROR_CODES.has(failure.code)) return;
      const record = this.findBySessionId(session?.header?.id ?? session?.id);
      if (record === undefined) return;
      const target = this.replyTargets.get(`${record.botId}:${record.kind}:${record.peerId}`);
      void this.sendText(record.peerId, `⚠️ 本轮异常结束\n${failure.code}: ${failure.message}`, target?.traceId);
    }
  }

  /** 是否把模型的思考过程发到微信（默认开）。 */
  showReasoning() {
    return this.config.showReasoning !== false;
  }

  /** 是否把工具调用与结果发到微信（默认开）。 */
  showTools() {
    return this.config.showTools !== false;
  }

  findBySessionId(sessionId) {
    if (sessionId === undefined) return undefined;
    for (const record of this.live.values()) {
      if (record.agent?.session?.id === sessionId) return record;
    }
    return undefined;
  }

  /**
   * 发送文本（自动切分）。
   *
   * @param {string} peerId
   * @param {string} text
   * @param {string | undefined} traceId
   */
  async sendText(peerId, text, traceId) {
    const chunks = splitText(text, this.config.textChunkLimit);
    for (const chunk of chunks) {
      const result = await this.client.send({ content: chunk, to: peerId, traceId });
      if (!result.ok) this.logger.error(`[openilink] 发送失败：${result.error}`);
    }
  }

  /**
   * 发送一张图片或文件（供 agent 工具调用）。
   *
   * @param {{ to: string, url?: string, type?: 'image'|'file'|'video', content?: string, filename?: string, traceId?: string }} message
   */
  async sendMedia(message) {
    return this.client.send(message);
  }
}

/**
 * 构造 user/message。
 *
 * `@deepseek-ai/dsh-llm` 属于宿主安装（profile 的 node_modules 里没有它），
 * 因此按需从 Loader 所在位置解析；解析失败时退回手写同构消息（内容相同，
 * 只缺 id，由 Session.append 侧补）。这样插件在 profile 安装布局下也能工作。
 *
 * @param {Array<object>} content
 * @returns {Promise<any>}
 */
async function createUserMessageSafely(content) {
  const loaded = await loadDshLlm();
  if (loaded?.createUserMessage) return loaded.createUserMessage({ content, source: { kind: 'user' } });
  return { role: 'user', content, source: { kind: 'user' }, id: randomUUID() };
}

/** 尝试解析宿主的 @deepseek-ai/dsh-llm。 */
async function loadDshLlm() {
  const candidates = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-agent'];
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      if (typeof mod?.createUserMessage === 'function') return mod;
    } catch {
      // 继续尝试下一个。
    }
  }
  return undefined;
}

/** 提取一条 assistant 消息里的文本块。 */
export function assistantText(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/** 提取一条 assistant 消息里的思考（reasoning）块。 */
export function assistantReasoning(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text.trim());
    }
  }
  return parts.join('\n\n').trim();
}

/** 截断一段文本到指定长度（保留尾部省略标记）。 */
function clip(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（已截断）`;
}

/**
 * 工具调用 → 微信可读文本。
 *
 * @param {string | undefined} name
 * @param {string | undefined} rawArgs 模型产出的原始 JSON 字符串
 * @returns {string}
 */
export function toolCallText(name, rawArgs) {
  const label = String(name ?? '?');
  const args = String(rawArgs ?? '').trim();
  if (args === '' || args === '{}') return `${TOOL_CALL_PREFIX} \`${label}\``;
  let rendered = args;
  try {
    const parsed = JSON.parse(args);
    rendered = JSON.stringify(parsed, undefined, 0);
  } catch {
    // 非 JSON 参数按原文展示。
  }
  return `${TOOL_CALL_PREFIX} \`${label}\`\n${clip(rendered, TOOL_ARGS_PREVIEW_LIMIT)}`;
}

/** 从 tool/result 事件里取出结果文本。 */
export function toolResultText(name, data) {
  const label = name === undefined ? '工具' : String(name);
  const error = data?.error;
  const blocks = data?.message?.content;
  const parts = [];
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        parts.push(block.text.trim());
      } else if (block?.type === 'image') {
        parts.push('[图片]');
      }
    }
  }
  const body = clip(parts.join('\n'), TOOL_RESULT_PREVIEW_LIMIT);
  if (error !== undefined && error !== null) {
    const code = [error.name, error.code].filter(Boolean).join(': ');
    const reason = typeof error.reason === 'string' && error.reason !== '' ? `\n${error.reason}` : '';
    return `${TOOL_FAILED_PREFIX} \`${label}\`${code ? `（${code}）` : ''}${body ? `\n${body}` : ''}${reason}`;
  }
  return body === '' ? `${TOOL_DONE_PREFIX} \`${label}\`` : `${TOOL_DONE_PREFIX} \`${label}\`\n${body}`;
}

/** 从 turn/end reason 提取失败信息。 */
export function turnFailure(reason) {
  if (reason === null || typeof reason !== 'object' || reason.kind !== 'error') return undefined;
  const detail = reason.error ?? reason.failure;
  return {
    code: String(detail?.code ?? reason.code ?? 'UNKNOWN'),
    message: String(detail?.message ?? reason.message ?? 'unknown error'),
  };
}
