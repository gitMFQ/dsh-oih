/**
 * 会话路由：把 Hub 的 (bot, 私聊/群) 对映射到一个 dsh Agent 会话。
 *
 * 会话 id 采用 dsh-im-connect 的频道约定：
 *
 *   im:<渠道实例>:<dm|group>[:<13 位时间戳>]:<chatId>
 *
 * 这样会话会出现在网页侧栏的「频道 → 微信」分组，而不是混在「任务」里：
 * im-connect 用渠道实例下划线前的平台前缀查 `CHANNEL_META`（`weixin_*` → 微信），
 * 并要求整段实例 id 匹配 `^[a-z0-9_-]+$`、kind 只能是 `dm` / `group`。
 *
 * 会话 id 由 peer 确定性派生，进程重启后 resume 到同一个会话；用户主动
 * 「新建会话」时带上新时间戳分段，id 随之变化（旧会话的历史留在磁盘上不动）。
 *
 * @module dsh-openilink-channel/sessions
 */
import { createHash } from 'node:crypto';

/** 派生种子命名空间：只参与解析，不进入会话 id。 */
export const OPENILINK_SESSION_PREFIX = 'openilink:';

/** 频道会话 id 前缀：im-connect 据此把会话归入「频道」而不是「任务」。 */
export const IM_SESSION_PREFIX = 'im:';

/**
 * 渠道实例 id 的平台前缀。
 *
 * 必须是 im-connect 已知的平台（`CHANNEL_META` 的键），它决定会话归到哪个频道
 * 分组；这里选 `weixin`，于是 OpeniLink 的会话与其它微信账号同组。
 */
export const CHANNEL_PLATFORM = 'weixin';

/** 实例前缀：`weixin_openilink_<bot 摘要>`。 */
const INSTANCE_PREFIX = `${CHANNEL_PLATFORM}_openilink`;

/**
 * 轮换标记：seed 末尾的 `#rot=<13 位时间戳>`，对应 im-connect 会话 id 里的时间戳段。
 *
 * 用显式标记而不是裸时间戳，是为了让 peer 自身以数字结尾时不会被误判成轮换；
 * 用时间戳而不是裸 uuid，是因为 im-connect 解析 id 时只把「纯数字段」当作时间戳
 * 剥离，这样轮换后的 chatId 仍然是干净的 peer id，侧栏不会出现拼接串。
 */
const ROTATE_MARK = '#rot=';
const STAMP_RE = /^\d{13,}$/;

/**
 * 由 bot 标识得到渠道实例 id。
 *
 * 同一个 Hub App 可能接多个 Bot，不同 Bot 的 peer id 空间互不相干（同一个微信
 * 用户也可能分别给两个 Bot 发消息），因此实例 id 必须按 Bot 区分，否则两条
 * 会话会撞进同一个 id。
 *
 * @param {unknown} botId
 * @returns {string} 形如 `weixin_openilink_1a2b3c4d`
 */
export function channelInstance(botId) {
  const seed = typeof botId === 'string' && botId.trim() !== '' ? botId.trim() : 'unknown';
  const digest = createHash('sha256').update(seed).digest('hex').slice(0, 8);
  return `${INSTANCE_PREFIX}_${digest}`;
}

/**
 * 把 Hub 的会话种类折算成频道约定里的 kind。
 *
 * @param {'direct'|'group'|string} kind
 * @returns {'dm'|'group'}
 */
export function channelKind(kind) {
  if (kind === 'group') return 'group';
  if (kind === 'direct') return 'dm';
  throw new TypeError(`未知会话种类：${String(kind)}`);
}

/**
 * 把 peer 标识整理成可以安全放进会话 id 的 chatId。
 *
 * 只去掉首尾空白，不改语义：`@im.wechat`、`@chatroom` 这类后缀原样保留，
 * 正好用来和 im-connect 自己绑定的微信账号区分。
 *
 * @param {unknown} peerId
 * @returns {string}
 */
export function channelChatId(peerId) {
  const value = typeof peerId === 'string' ? peerId.trim() : '';
  if (value === '') throw new TypeError('会话 peer 不能为空');
  return value;
}

/**
 * 拆解 seed。
 *
 * 形态：`openilink:<bot>:<direct|group>:<peer>`，轮换后在末尾追加
 * `#rot=<13 位时间戳>`。peer 自身可能含冒号（微信 id、群 id），因此按前两段
 * 定位，其余整段视为 peer。
 *
 * @param {string} seed
 * @returns {{ botId: string, kind: 'direct'|'group', peerId: string, stamp?: string }}
 */
function parseSeed(seed) {
  const text = String(seed ?? '');
  if (!text.startsWith(OPENILINK_SESSION_PREFIX)) throw new TypeError(`会话 seed 前缀无效：${text}`);
  const rest = text.slice(OPENILINK_SESSION_PREFIX.length);
  const first = rest.indexOf(':');
  const second = rest.indexOf(':', first + 1);
  if (first <= 0 || second <= first) throw new TypeError(`会话 seed 分段无效：${text}`);
  const botId = rest.slice(0, first);
  const rawKind = rest.slice(first + 1, second);
  let tail = rest.slice(second + 1);
  let stamp;
  const mark = tail.lastIndexOf(ROTATE_MARK);
  if (mark >= 0) {
    const candidate = tail.slice(mark + ROTATE_MARK.length);
    if (!STAMP_RE.test(candidate)) throw new TypeError(`会话 seed 时间戳无效：${text}`);
    stamp = candidate;
    tail = tail.slice(0, mark);
  }
  return { botId, kind: /** @type {'direct'|'group'} */ (rawKind), peerId: tail, ...(stamp === undefined ? {} : { stamp }) };
}

/**
 * 由 seed 派生频道形态的会话 id。
 *
 * - 首次：`im:weixin_openilink_<bot>:dm:<peer>`
 * - 轮换后：`im:weixin_openilink_<bot>:dm:<stamp>:<peer>`（im-connect 会剥掉
 *   时间戳段，聊天 id 仍是 peer，但会话身份已刷新）
 *
 * @param {string} seed `sessionSeed()` 的返回值（轮换时带 `#rot=<stamp>`）
 * @returns {string}
 */
export function deriveSessionId(seed) {
  const { botId, kind, peerId, stamp } = parseSeed(seed);
  const head = `${IM_SESSION_PREFIX}${channelInstance(botId)}:${channelKind(kind)}`;
  const chatId = channelChatId(peerId);
  return stamp === undefined ? `${head}:${chatId}` : `${head}:${stamp}:${chatId}`;
}

/** 由 peer 信息得到稳定 seed。 */
export function sessionSeed(botId, kind, peerId) {
  return `${OPENILINK_SESSION_PREFIX}${botId}:${kind}:${peerId}`;
}

/**
 * 一个 peer（私聊用户或群）的会话登记。
 */
export class SessionRegistry {
  /**
   * @param {{ logger?: { info: Function, warn: Function, debug: Function } }} options
   */
  constructor(options = {}) {
    this.logger = options.logger;
    /** @type {Map<string, { seed: string, sessionId: string, generation: number }>} */
    this.entries = new Map();
  }

  /**
   * 读取（或建立）一个 peer 的会话身份。
   *
   * @param {string} botId
   * @param {'direct'|'group'} kind
   * @param {string} peerId
   * @returns {{ seed: string, sessionId: string, generation: number, key: string }}
   */
  identity(botId, kind, peerId) {
    const key = `${botId}:${kind}:${peerId}`;
    let entry = this.entries.get(key);
    if (entry === undefined) {
      const seed = sessionSeed(botId, kind, peerId);
      entry = { seed, sessionId: deriveSessionId(seed), generation: 0 };
      this.entries.set(key, entry);
    }
    return { key, ...entry };
  }

  /**
   * 开新会话：换一个 seed（保留旧会话的持久化历史不动）。
   *
   * @param {string} botId
   * @param {'direct'|'group'} kind
   * @param {string} peerId
   * @param {number} [now] 时间戳（测试用）
   * @returns {{ seed: string, sessionId: string, generation: number, key: string }}
   */
  rotate(botId, kind, peerId, now = Date.now()) {
    const current = this.identity(botId, kind, peerId);
    const seed = `${sessionSeed(botId, kind, peerId)}${ROTATE_MARK}${String(now).padStart(13, '0')}`;
    const entry = { seed, sessionId: deriveSessionId(seed), generation: current.generation + 1 };
    this.entries.set(current.key, entry);
    this.logger?.info?.(`[openilink] 新会话：${current.key} → ${entry.sessionId}`);
    return { key: current.key, ...entry };
  }

  /** 清空内存登记（插件卸载时调用；磁盘上的会话保留）。 */
  clear() {
    this.entries.clear();
  }
}
