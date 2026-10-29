/**
 * OpeniLink Hub Bot API 客户端。
 *
 * 只做两件事：一条 per-installation WebSocket（收事件）和 HTTP 发送（发消息）。
 * 协议见 https://github.com/openilink/openilink-hub 的 docs/app-development.md。
 *
 * @module dsh-openilink-channel/hub
 */

/** 事件信封里的媒体项（Hub 的 relay item）。 */
export const HUB_MEDIA_TYPES = ['text', 'image', 'voice', 'file', 'video'];

/** 归一化 hub 根地址：去掉尾部斜杠。 */
export function normalizeHubUrl(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') return '';
  return value.replace(/\/+$/, '');
}

/** 由 http(s) 根地址推导 WebSocket 地址。 */
export function websocketUrl(hubUrl, appToken) {
  const base = normalizeHubUrl(hubUrl);
  if (base === '') throw new Error('hubUrl 未配置');
  const ws = base.replace(/^http(s?):\/\//i, 'ws$1://');
  return `${ws}/bot/v1/ws?token=${encodeURIComponent(appToken)}`;
}

/** 文件大小的人类可读形式。 */
export function formatFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 把事件 data 里的 items 渲染成模型可读的正文。
 *
 * 文本项直接进正文；媒体项渲染成 `[File: name (size)]\n<url>` 形式，
 * 让模型能判断用户发了什么，并按需用 curl/read_image 取回内容。
 *
 * @param {string} content 事件里的纯文本 content
 * @param {string | undefined} msgType message.text / message.file ...
 * @param {Array<object> | undefined} items relay items
 * @returns {string}
 */
export function renderItems(content, msgType, items) {
  const text = String(content ?? '');
  if (!Array.isArray(items) || items.length === 0) return text;

  const parts = [];
  let sawTextItem = false;
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    switch (item.type) {
      case 'text':
        if (typeof item.text === 'string' && item.text !== '') {
          parts.push(item.text);
          sawTextItem = true;
        }
        break;
      case 'file': {
        const name = item.file_name || 'file';
        const size = formatFileSize(item.media?.file_size);
        const url = item.media?.url ? `\n${item.media.url}` : '';
        parts.push(`[File: ${name}${size ? ` (${size})` : ''}]${url}`);
        break;
      }
      case 'image':
        parts.push(`[Image]${item.media?.url ? `\n${item.media.url}` : ''}`);
        break;
      case 'voice': {
        const duration = item.media?.play_time ? ` ${item.media.play_time}s` : '';
        parts.push(`[Voice${duration}]${item.media?.url ? `\n${item.media.url}` : ''}`);
        break;
      }
      case 'video': {
        const duration = item.media?.play_length ? ` ${item.media.play_length}s` : '';
        parts.push(`[Video${duration}]${item.media?.url ? `\n${item.media.url}` : ''}`);
        break;
      }
      default:
        break;
    }
  }

  // 媒体消息的 caption 通常只在 content 里；文本项已经带了正文时不再重复。
  if (text !== '' && !sawTextItem && parts.length > 0) parts.unshift(text);
  const rendered = parts.join('\n').trim();
  return rendered !== '' ? rendered : text;
}

/**
 * 按长度切分文本，尽量在段落/换行边界断开。
 *
 * @param {string} text
 * @param {number} limit 单条上限
 * @returns {string[]}
 */
export function splitText(text, limit) {
  const source = String(text ?? '');
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 4000;
  if (source.length <= max) return source === '' ? [] : [source];

  const chunks = [];
  let rest = source;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut <= 0) cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest !== '') chunks.push(rest);
  return chunks;
}

/**
 * 一个 Hub 安装实例的 Bot API 客户端。
 */
export class HubClient {
  /**
   * @param {{ hubUrl: string, appToken: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
   */
  constructor(options) {
    this.hubUrl = normalizeHubUrl(options.hubUrl);
    this.appToken = String(options.appToken ?? '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get configured() {
    return this.hubUrl !== '' && this.appToken !== '';
  }

  /**
   * 发送文本或媒体消息。
   *
   * @param {{ content?: string, type?: 'text'|'image'|'video'|'file', url?: string, to?: string, filename?: string, traceId?: string }} message
   * @returns {Promise<{ ok: true, clientId?: string } | { ok: false, error: string }>}
   */
  async send(message) {
    if (!this.configured) return { ok: false, error: 'OpeniLink 尚未配置 hubUrl / appToken' };
    const body = { type: message.type ?? 'text' };
    if (typeof message.content === 'string') body.content = message.content;
    if (message.url) body.url = message.url;
    if (message.filename) body.filename = message.filename;
    if (message.to) body.to = message.to;
    if (message.traceId) body.trace_id = message.traceId;

    let response;
    try {
      response = await this.fetchImpl(`${this.hubUrl}/bot/v1/message/send`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.appToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { ok: false, error: describeFetchError(error) };
    }

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      return { ok: false, error: `Hub 返回 ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}` };
    }
    let parsed;
    try {
      parsed = text === '' ? {} : JSON.parse(text);
    } catch {
      parsed = {};
    }
    if (parsed && parsed.ok === false) {
      return { ok: false, error: String(parsed.error ?? 'Hub 拒绝了该消息') };
    }
    return { ok: true, ...(parsed?.client_id ? { clientId: String(parsed.client_id) } : {}) };
  }

  /**
   * 读取 Bot 信息（同时用作连通性探测）。
   *
   * `/bot/v1/info` 需要 `bot:read` scope，但 Hub 的内置 App（openclaw、bridge、
   * runner）只声明了 `message:read` + `message:write`，所以一个完全能收发微信的
   * Token 在这里也会拿到 403 `missing scope: bot:read`。
   *
   * 这不代表凭据有问题：Hub 的 `appTokenAuth` 先用 `GetInstallationByToken`
   * 校验 token，通过后才检查 scope，所以 401 才是“凭据无效”，403 说明 token
   * 已被 Hub 认可、只是这个 App 没申请 bot:read。此时返回 `ok: true` 加一条
   * warning（读不到 Bot 名称而已），不要挡住保存。
   *
   * @returns {Promise<{ ok: true, bot?: unknown, warning?: string } | { ok: false, error: string }>}
   */
  async info() {
    if (!this.configured) return { ok: false, error: 'OpeniLink 尚未配置 hubUrl / appToken' };
    let response;
    try {
      response = await this.fetchImpl(`${this.hubUrl}/bot/v1/info`, {
        headers: { authorization: `Bearer ${this.appToken}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { ok: false, error: describeFetchError(error) };
    }

    const text = await response.text().catch(() => '');
    let parsed = {};
    try {
      parsed = text === '' ? {} : JSON.parse(text);
    } catch {
      parsed = {};
    }

    if (response.ok) {
      if (parsed?.ok === false) return { ok: false, error: String(parsed.error ?? 'Hub 返回错误') };
      return { ok: true, bot: parsed?.bot };
    }

    // 401：token 本身无效（Hub 在查安装实例时就拒绝了），没得救。
    if (response.status === 401) {
      return { ok: false, error: `凭据无效：${String(parsed?.error ?? 'Hub 返回 401')}` };
    }

    // 403 + 缺 scope：token 已通过认证，只是没有 bot:read。凭据本身没问题。
    const missingScope = typeof parsed?.error === 'string' && parsed.error.startsWith('missing scope:');
    if (response.status === 403 && missingScope) {
      return { ok: true, warning: '当前 App 未授予 bot:read，读不到 Bot 名称（不影响收发消息）' };
    }

    return { ok: false, error: `Hub 返回 ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}` };
  }
}

/** 把 fetch/超时错误收敛成一句人话。 */
export function describeFetchError(error) {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return '请求 Hub 超时';
    const cause = error.cause;
    if (cause instanceof Error && cause.message) return `${error.message}（${cause.message}）`;
    return error.message;
  }
  return String(error);
}
