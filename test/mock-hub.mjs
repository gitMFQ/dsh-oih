/**
 * Mock OpeniLink Hub —— 模拟 Hub 侧，用于本插件的协议级测试。
 *
 * - WS  /bot/v1/ws          : 发 init，随后推送可编排的事件
 * - POST /bot/v1/message/send : 记录出站消息
 * - GET  /bot/v1/info         : 返回 bot 信息
 *
 * 环境变量：
 *   MOCK_HUB_PORT        HTTP+WS 端口（默认 9200）
 *   MOCK_HUB_MESSAGE     入站文本（默认 "hello from test"）
 *   MOCK_HUB_SENDER_ID   发送者 id
 *   MOCK_HUB_SENDER_NAME 发送者昵称
 *   MOCK_HUB_GROUP       设置后作为群消息的 group id
 */
import { createServer } from 'node:http';
const wsModule = await import(process.env.MOCK_HUB_WS_MODULE ?? 'ws');
const WebSocketServer = wsModule.WebSocketServer ?? wsModule.default?.WebSocketServer;

/** 1x1 透明 PNG，用作媒体下载测试素材。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export function startMockHub(options = {}) {
  const port = options.port ?? 0;
  const replies = [];
  const events = [];

  const httpServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && req.url === '/replies') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(replies));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/replies') {
      replies.length = 0;
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && req.url === '/bot/v1/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bot: { id: 'bot-1', name: 'Mock Bot', status: 'connected' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/media/test.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_1PX);
      return;
    }
    if (req.method === 'POST' && req.url === '/__push') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        const event = pushMessage(parsed);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, trace_id: event.trace_id }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/bot/v1/message/send') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        replies.push(parsed);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, client_id: `msg-${replies.length}` }));
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/bot/v1/ws' });
  /** @type {Set<import('ws').WebSocket>} */
  const clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        // 忽略非 JSON 帧
      }
    });
    ws.send(
      JSON.stringify({
        type: 'init',
        data: { installation_id: 'inst-1', bot_id: 'bot-1', app_name: 'Mock', app_slug: 'mock' },
      }),
    );
  });

  /** 推送一条事件给全部连接。 */
  function push(event) {
    events.push(event);
    const frame = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === 1) client.send(frame);
    }
  }

  /** 构造并推送一条消息事件。 */
  function pushMessage({
    text = 'hello from test',
    senderId = 'test-user-1',
    senderName = 'TestUser',
    group = null,
    msgType = 'text',
    items,
  } = {}) {
    const event = {
      type: 'event',
      v: 1,
      trace_id: `trace-${events.length + 1}`,
      installation_id: 'inst-1',
      bot: { id: 'bot-1' },
      event: {
        type: `message.${msgType}`,
        id: `evt-${events.length + 1}`,
        timestamp: Math.floor(Date.now() / 1000),
        data: {
          sender: { id: senderId, name: senderName, role: 'user' },
          group,
          content: text,
          msg_type: msgType,
          items: items ?? [{ type: 'text', text }],
        },
      },
    };
    push(event);
    return event;
  }

  return {
    port,
    replies,
    events,
    clients,
    push,
    pushMessage,
    get url() {
      const address = httpServer.address();
      const actual = typeof address === 'object' && address !== null ? address.port : port;
      return `http://127.0.0.1:${actual}`;
    },
    async listen() {
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, '127.0.0.1', () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
      return this;
    },
    async close() {
      for (const client of clients) client.close();
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}
