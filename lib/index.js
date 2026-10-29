/**
 * dsh-openilink-channel —— OpeniLink Hub 微信 Bot 通道插件（Host 半边）。
 *
 * 参考 https://github.com/openilink/openclaw-channel-openilink 的协议实现，
 * 把同一套 Hub Bot API 接到 DeepSeek Harness 的 Agent 会话上：
 *
 *   微信用户 ⇄ OpeniLink Hub ⇄ [本插件] ⇄ dsh Agent 会话
 *
 * Host 半边负责连接、会话、出站投递与状态/配置路由；Client 半边
 * （./client）在设置页提供连接状态与凭据编辑。
 *
 * @module dsh-openilink-channel
 */
import Schema from '@deepseek-ai/schemastery';
import { OpeniLinkGateway } from './gateway.js';
import { HubClient, describeFetchError, normalizeHubUrl } from './hub.js';

export const name = 'im-openilink';

/**
 * 硬依赖只有 agents；其余服务（webServer / tools / configEditor /
 * agentPresets / agentDefaultModel）都按可选处理：缺失时相应功能降级，
 * 插件本身照常激活。
 */
export const inject = ['agents'];

/** 访问控制子 Schema。 */
export const AccessSchema = Schema.object({
  mode: Schema.union(['open', 'allow']).default('open').description('open=所有人可用；allow=仅白名单用户'),
  allow: Schema.array(Schema.string()).default([]).description('白名单（微信 sender id）'),
});

/** 媒体处理子 Schema。 */
export const MediaSchema = Schema.object({
  enabled: Schema.boolean().default(true).description('是否把微信图片下载成图片附件交给模型'),
  maxMB: Schema.natural().default(30).description('单张图片下载上限（MB）'),
});

export const Config = Schema.object({
  hubUrl: Schema.string().default('').description('OpeniLink Hub 地址，如 https://hub.openilink.com'),
  appToken: Schema.string().role('secret').default('').description('Hub 安装实例的 App Token'),
  cwd: Schema.string().default('').description('Agent 工作目录（留空=Harness 进程当前目录）'),
  agentPreset: Schema.string().default('').description('Agent preset id（留空=沿用宿主组合）'),
  provider: Schema.string().default('').description('LLM provider（留空=宿主默认模型）'),
  model: Schema.string().default('').description('LLM 模型（留空=宿主默认模型）'),
  reasoningEffort: Schema.string().default('').description('推理强度（留空=模型默认，如 off/low/high/max）'),
  textChunkLimit: Schema.natural().default(4000).description('单条消息最大字符数'),
  sessionIdleMinutes: Schema.natural().default(30).description('会话闲置回收时间（分钟），0=不回收'),
  access: AccessSchema.default({ mode: 'open', allow: [] }).description('访问控制'),
  media: MediaSchema.default({ enabled: true, maxMB: 30 }).description('媒体处理'),
  showReasoning: Schema.boolean().default(true).description('把模型的思考过程发到微信'),
  showTools: Schema.boolean().default(true).description('把工具调用与结果发到微信'),
  debug: Schema.boolean().default(false).description('输出调试日志'),
});

/** 状态/配置路由前缀。 */
export const ROUTE_PREFIX = '/openilink/im-openilink';
/** 客户端与宿主共用的路径常量。 */
export const ROUTES = {
  status: `${ROUTE_PREFIX}/status`,
  config: `${ROUTE_PREFIX}/config`,
  settings: `${ROUTE_PREFIX}/settings`,
  models: `${ROUTE_PREFIX}/models`,
};

/**
 * @param {any} ctx
 * @param {any} config
 */
export function apply(ctx, config) {
  const logger = createLogger(ctx, config.debug === true);
  const gateway = new OpeniLinkGateway({ ctx, config, logger });

  // 出站：助手回复 → Hub。
  ctx.effect(
    () => ctx.on('session/event', (session, event) => gateway.onSessionEvent(session, event)),
    'im-openilink.session-events',
  );

  // 入站连接：先连，连接失败时由 gateway 自己退避重连。
  ctx.effect(
    () => {
      gateway.connect();
      gateway.startIdleSweep();
      return () => {
        void gateway.dispose();
      };
    },
    'im-openilink.gateway',
  );

  // 状态/配置路由（Web GUI 设置页用）。
  ctx.inject(['webServer'], (webCtx) => {
    const disposers = [
      webCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.status,
        handler: (req, res) => handleStatus(req, res, ctx, gateway),
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.config,
        handler: (req, res) => handleConfig(req, res, ctx, gateway),
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.settings,
        handler: (req, res) => handleSettings(req, res, ctx, gateway),
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: ROUTES.models,
        handler: (req, res) => handleModels(req, res, ctx),
      }),
    ];
    webCtx.effect(() => () => {
      for (const dispose of disposers.reverse()) dispose();
    }, 'im-openilink.routes');
  });

  // Agent 工具：让模型能主动发消息/查状态。
  ctx.inject(['tools'], (toolCtx) => {
    const disposers = registerTools(toolCtx, gateway, logger);
    toolCtx.effect(() => () => {
      for (const dispose of disposers.reverse()) dispose();
    }, 'im-openilink.tools');
  });

  logger.info(
    gateway.client.configured
      ? `[openilink] 已加载，Hub=${gateway.hubUrl}`
      : '[openilink] 已加载，但尚未配置 hubUrl / appToken（可在 设置 → OpeniLink 微信 中填写）',
  );

  return gateway;
}

/** 建立带前缀的 logger。 */
function createLogger(ctx, debug) {
  let base;
  try {
    base = ctx.logger(name);
  } catch {
    base = ctx.logger ?? console;
  }
  return {
    info: (...args) => base.info?.(...args),
    warn: (...args) => base.warn?.(...args),
    error: (...args) => base.error?.(...args),
    debug: debug ? (...args) => base.debug?.(...args) : () => {},
  };
}

// ── HTTP 路由 ─────────────────────────────────────────────────────

/** 最小同源校验（本路由只回显状态与保存凭据，不跨站暴露）。 */
function trusted(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req, limit = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

async function handleStatus(req, res, ctx, gateway) {
  if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
  const status = gateway.status();
  let bot;
  let warning;
  if (gateway.client.configured) {
    const info = await gateway.client.info();
    if (info.ok) {
      bot = info.bot;
      // 缺 bot:read 只影响 Bot 名称展示，不写进 lastError 吓人。
      if (info.warning) warning = info.warning;
    } else {
      status.lastError = status.lastError ?? info.error;
    }
  }
  sendJson(res, 200, { ...status, bot, ...(warning ? { warning } : {}) });
}

async function handleConfig(req, res, ctx, gateway) {
  if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: describeFetchError(error) });
  }

  const hubUrl = normalizeHubUrl(body?.hubUrl ?? '');
  const appToken = String(body?.appToken ?? '').trim();
  if (hubUrl !== '' && !/^https?:\/\//i.test(hubUrl)) {
    return sendJson(res, 400, { error: 'Hub 地址必须以 http:// 或 https:// 开头' });
  }

  // 先探测，避免把错配置写进 profile 后反复重连。
  // 缺 bot:read scope 的 App 用 WS 握手校验，不因此判定凭据错误。
  let warning;
  if (hubUrl !== '' && appToken !== '') {
    const probe = await new HubClient({ hubUrl, appToken }).info();
    if (!probe.ok) return sendJson(res, 200, { ok: false, error: `连接失败：${probe.error}` });
    if (probe.warning) warning = probe.warning;
  }

  const saved = await saveCredentials(ctx, { hubUrl, appToken });
  if (!saved.ok) return sendJson(res, 200, { ok: false, error: saved.error });
  return sendJson(res, 200, { ok: true, restartRequired: saved.restartRequired, ...(warning ? { warning } : {}) });
}

/**
 * 把凭据写回 profile 的 cordis.patch.yml。
 *
 * 通过 configEditor 写入后 Loader 会热重载本插件（连接随之重建），
 * 因此这里只返回结果，不再手动重启 gateway。
 */
async function saveCredentials(ctx, { hubUrl, appToken }) {
  return editPluginConfig(ctx, { hubUrl, appToken });
}

/**
 * 把一组字段合并写回本插件在 profile 里的配置行。
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} patch 只覆盖给出的字段
 */
async function editPluginConfig(ctx, patch) {
  let editor;
  try {
    editor = ctx.get?.('configEditor');
  } catch {
    editor = undefined;
  }
  if (editor === undefined || editor === null) {
    return { ok: false, error: '当前 profile 不支持配置写回，请改用环境变量 OPENILINK_HUB_URL / OPENILINK_APP_TOKEN' };
  }
  const entry = ctx.fiber?.entry;
  if (entry === undefined) return { ok: false, error: '无法定位本插件配置行' };
  try {
    await editor.edit(entry, (current) => ({ ...current, ...patch }));
    return { ok: true, restartRequired: false };
  } catch (error) {
    return { ok: false, error: describeFetchError(error) };
  }
}

// ── 设置（模型 / 展示开关）───────────────────────────────────────

/** 设置页可写字段的白名单（其余字段走 patch 或环境变量）。 */
const EDITABLE_SETTINGS = new Set([
  'provider',
  'model',
  'reasoningEffort',
  'showReasoning',
  'showTools',
  'textChunkLimit',
  'sessionIdleMinutes',
]);

/** 读取当前生效的插件配置（脱敏）。 */
function currentSettings(gateway) {
  const config = gateway.config ?? {};
  return {
    provider: String(config.provider ?? ''),
    model: String(config.model ?? ''),
    reasoningEffort: String(config.reasoningEffort ?? ''),
    showReasoning: config.showReasoning !== false,
    showTools: config.showTools !== false,
    textChunkLimit: Number(config.textChunkLimit ?? 4000),
    sessionIdleMinutes: Number(config.sessionIdleMinutes ?? 30),
  };
}

/** 宿主默认模型路由（用于设置页展示「继承自宿主」）。 */
function hostDefaultSelection(ctx) {
  try {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.();
    if (selection?.provider && selection?.model) {
      return {
        provider: String(selection.provider),
        model: String(selection.model),
        ...(selection.reasoningEffort ? { reasoningEffort: String(selection.reasoningEffort) } : {}),
      };
    }
  } catch {
    // 服务缺失时没有宿主默认可展示。
  }
  return undefined;
}

async function handleSettings(req, res, ctx, gateway) {
  if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
  if (req.method === 'GET' || req.method === 'HEAD') {
    return sendJson(res, 200, {
      settings: currentSettings(gateway),
      hostDefault: hostDefaultSelection(ctx),
    });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: describeFetchError(error) });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
  }

  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    if (!EDITABLE_SETTINGS.has(key)) return sendJson(res, 400, { error: `不支持的字段：${key}` });
    if (key === 'showReasoning' || key === 'showTools') {
      if (typeof value !== 'boolean') return sendJson(res, 400, { error: `${key} 必须是布尔值` });
      patch[key] = value;
      continue;
    }
    if (key === 'textChunkLimit' || key === 'sessionIdleMinutes') {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) return sendJson(res, 400, { error: `${key} 必须是非负数字` });
      patch[key] = Math.floor(number);
      continue;
    }
    if (typeof value !== 'string') return sendJson(res, 400, { error: `${key} 必须是字符串` });
    const text = value.trim();
    if (text.length > 200) return sendJson(res, 400, { error: `${key} 过长` });
    patch[key] = text;
  }
  if (Object.keys(patch).length === 0) return sendJson(res, 400, { error: '没有可保存的字段' });

  // provider/model 要么都给，要么都不给（只给一个会退回宿主默认，容易被误读）。
  const provider = patch.provider ?? String(gateway.config?.provider ?? '');
  const model = patch.model ?? String(gateway.config?.model ?? '');
  if ((provider === '') !== (model === '')) {
    return sendJson(res, 400, { error: 'provider 与 model 需要同时填写或同时留空' });
  }

  const saved = await editPluginConfig(ctx, patch);
  if (!saved.ok) return sendJson(res, 200, { ok: false, error: saved.error });
  return sendJson(res, 200, { ok: true, restartRequired: saved.restartRequired });
}

/**
 * 列出宿主已注册的 provider 与模型，供设置页下拉选择。
 *
 * 任何一步失败都降级为空列表：设置页仍可手动输入 provider/model。
 */
async function handleModels(req, res, ctx) {
  if (!trusted(req)) return sendJson(res, 403, { error: 'forbidden' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });

  let llm;
  try {
    llm = ctx.get?.('llm');
  } catch {
    llm = undefined;
  }
  if (llm === undefined || llm === null) return sendJson(res, 200, { providers: [], models: [] });

  let providers = [];
  try {
    providers = (llm.listProviders?.() ?? []).map((entry) => ({ id: String(entry.id), name: String(entry.name) }));
  } catch {
    providers = [];
  }

  const models = [];
  for (const provider of providers) {
    try {
      const list = await llm.listModels?.(provider.id);
      for (const model of list ?? []) {
        models.push({
          provider: provider.id,
          id: String(model.id),
          name: String(model.name ?? model.id),
          ...(model.description ? { description: String(model.description) } : {}),
        });
      }
    } catch {
      // 单个 provider 列不出模型不影响其它 provider。
    }
  }

  // 把每个模型支持的推理强度也带上，供设置页做二级选择。
  for (const model of models) {
    try {
      const info = await llm.resolveModelInfo?.(model.provider, model.id);
      const reasoning = info?.reasoning;
      if (reasoning !== undefined) {
        model.efforts = (reasoning.efforts ?? []).map((effort) => String(effort.id));
        if (reasoning.defaultEffort !== undefined) model.defaultEffort = String(reasoning.defaultEffort);
      }
    } catch {
      // 能力查询失败时该模型不提供推理强度选项。
    }
  }

  return sendJson(res, 200, { providers, models });
}

// ── Agent 工具 ────────────────────────────────────────────────────

function registerTools(ctx, gateway, logger) {
  const disposers = [];
  const tools = ctx.tools;

  disposers.push(
    tools.register({
      name: 'openilink_send_text',
      description:
        '通过 OpeniLink Hub 向微信用户或群发送一条文本消息。to 为 Hub 事件里的 sender.id（私聊）或 group.id（群聊）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          to: { type: 'string', description: '接收方 id：私聊用 sender.id，群聊用 group.id' },
          text: { type: 'string', description: '要发送的文本' },
        },
        required: ['to', 'text'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: renderToolResult,
      },
      async execute(args) {
        if (!gateway.client.configured) return { ok: false, error: 'OpeniLink 尚未配置' };
        const chunks = String(args.text ?? '');
        if (chunks.trim() === '') return { ok: false, error: 'text 不能为空' };
        await gateway.sendText(String(args.to), chunks, undefined);
        return { ok: true };
      },
    }),
  );

  disposers.push(
    tools.register({
      name: 'openilink_send_media',
      description:
        '通过 OpeniLink Hub 向微信用户或群发送图片/文件/视频（按 URL）。Hub 会自行下载该 URL 并转发给微信。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          to: { type: 'string', description: '接收方 id：私聊用 sender.id，群聊用 group.id' },
          url: { type: 'string', description: '媒体文件的可公网访问 URL' },
          type: { type: 'string', enum: ['image', 'file', 'video'], description: '媒体类型，默认 image' },
          caption: { type: 'string', description: '可选文字说明' },
        },
        required: ['to', 'url'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: renderToolResult,
      },
      async execute(args) {
        if (!gateway.client.configured) return { ok: false, error: 'OpeniLink 尚未配置' };
        const url = String(args.url ?? '').trim();
        if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url 必须是 http(s) 地址' };
        const result = await gateway.sendMedia({
          to: String(args.to),
          url,
          type: args.type ?? 'image',
          content: args.caption,
        });
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      },
    }),
  );

  disposers.push(
    tools.register({
      name: 'openilink_status',
      description: '查看 OpeniLink 通道的连接状态、已绑定的会话，以及最近一次错误。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            configured: { type: 'boolean' },
            state: { type: 'string' },
            hubUrl: { type: 'string' },
            lastError: { type: 'string' },
            sessions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  key: { type: 'string' },
                  kind: { type: 'string' },
                  peerId: { type: 'string' },
                  sessionId: { type: 'string' },
                },
                required: ['key', 'kind', 'peerId'],
              },
            },
          },
          required: ['configured', 'state', 'hubUrl', 'sessions'],
        },
        render: renderToolResult,
      },
      async execute() {
        const status = gateway.status();
        return {
          configured: status.configured,
          state: status.state,
          hubUrl: status.hubUrl,
          ...(status.lastError ? { lastError: status.lastError } : {}),
          sessions: status.sessions.map((session) => ({
            key: session.key,
            kind: session.kind,
            peerId: session.peerId,
            ...(session.sessionId ? { sessionId: String(session.sessionId) } : {}),
          })),
        };
      },
    }),
  );

  logger.debug?.('[openilink] 已注册 3 个 Agent 工具');
  return disposers;
}

function renderToolResult(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}
