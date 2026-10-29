/**
 * 入站媒体处理：把微信图片取回来，作为真正的图片附件交给模型。
 *
 * Hub 的媒体代理 `/api/v1/channels/media` 接受 Bearer app token
 * （见 openilink-hub internal/api/media_handler.go 的 Auth path 3），
 * 因此本插件可以在服务端带 token 取回原图，而不是把 URL 丢给模型。
 *
 * 任何失败都退回文本形式（保留 URL），不影响消息本身送达。
 *
 * @module dsh-openilink-channel/media
 */

/** 单条消息最多内联的图片数。 */
const MAX_IMAGES_PER_MESSAGE = 4;

/** 图片魔数 → mediaType。只接受模型侧支持的四种位图格式。 */
export function detectImageMediaType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return undefined;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const gif = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF' &&
    String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

/**
 * 收集一条事件里可下载的图片项。
 *
 * @param {Array<object> | undefined} items
 * @returns {Array<{ url: string, name: string }>}
 */
export function imageItems(items) {
  if (!Array.isArray(items)) return [];
  const found = [];
  for (const item of items) {
    if (item?.type !== 'image') continue;
    const url = item?.media?.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    found.push({ url, name: item?.file_name || 'wechat-image' });
    if (found.length >= MAX_IMAGES_PER_MESSAGE) break;
  }
  return found;
}

/**
 * 下载并把图片提交为附件块。
 *
 * @param {{
 *   attachments: any,
 *   fetchImpl?: typeof fetch,
 *   appToken: string,
 *   maxBytes: number,
 *   timeoutMs?: number,
 *   logger?: { warn: Function },
 * }} options
 * @param {Array<{ url: string, name: string }>} images
 * @returns {Promise<Array<{ type: 'image', attachment: object }>>}
 */
export async function ingestImages(options, images) {
  const blocks = [];
  if (images.length === 0) return blocks;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxBytes = options.maxBytes > 0 ? options.maxBytes : 30 * 1024 * 1024;

  for (const image of images) {
    try {
      const response = await fetchImpl(image.url, {
        headers: options.appToken ? { authorization: `Bearer ${options.appToken}` } : {},
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      if (!response.ok) {
        options.logger?.warn?.(`[openilink] 图片下载失败 ${response.status}: ${image.url}`);
        continue;
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        options.logger?.warn?.(`[openilink] 图片超过 ${maxBytes} 字节上限，改为文本链接`);
        continue;
      }
      const mediaType = detectImageMediaType(buffer);
      if (mediaType === undefined) {
        options.logger?.warn?.('[openilink] 不是可识别的图片格式，改为文本链接');
        continue;
      }
      const ref = await options.attachments.saveImage({
        data: buffer,
        mediaType,
        name: image.name,
      });
      blocks.push({ type: 'image', attachment: ref });
    } catch (error) {
      options.logger?.warn?.(`[openilink] 图片处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return blocks;
}
