/**
 * 局域网监听网关。
 *
 * **为什么需要它**：桥默认挂在 DSH 的 `ctx.webServer` 上，而 DSH Desktop 的
 * webServer 只绑 `127.0.0.1`（回环），手机在局域网里根本够不到。
 * `dsh-host-webserver` 又拒绝通配地址（`0.0.0.0` 在 Schema 层就报错）。
 *
 * 所以这里另起一个**独立的 node:http 监听**，只服务桥的端点，
 * 与 DSH 主服务完全隔离：
 *  - 主服务挂了不影响它，它挂了不影响主服务；
 *  - 端口独立，不占 DSH 的随机端口；
 *  - 只绑一个具体的局域网 IP，不绑 `0.0.0.0`。
 *
 * 安全边界（与主桥一致，且更严）：
 *  - **强制要求 token**：独立监听暴露在局域网上，不配 token 就拒绝启动；
 *  - 只注册桥自己的路由，不转发到 DSH 的任何其他路径；
 *  - 跳数预算与主桥共用（同一套 protocol 模块）；
 *  - 请求体上限更小（局域网里没有可信的对端）。
 *
 * @module dsh-mobile-bridge/lan
 */

import { createServer } from 'node:http';
import { PROTOCOL_VERSION, ERROR_CODE } from './protocol.js';

/** 独立监听的默认端口。挑一个不常见的，避免与 DSH 随机端口撞。 */
export const DEFAULT_LAN_PORT = 61420;

/**
 * 校验监听配置。宁可启动失败，也不要悄悄绑到错误的地址上。
 *
 * @param {object} options - 配置。
 * @param {string} options.host - 要绑定的 IPv4 字面量。
 * @param {number} options.port - 端口。
 * @param {string} [options.token] - 共享令牌。
 * @returns {{ok: true, host: string, port: number, token: string} | {ok: false, reason: string}}
 */
export function validateLanOptions({ host, port, token }) {
  if (typeof host !== 'string' || host.trim() === '') {
    return { ok: false, reason: 'lan.host is required (a concrete IPv4 literal such as 192.168.1.3)' };
  }
  const trimmedHost = host.trim();

  // 明确拒绝通配地址：那等于把桥暴露到所有网卡，包括可能的公网侧。
  if (trimmedHost === '0.0.0.0' || trimmedHost === '::' || trimmedHost === '*') {
    return {
      ok: false,
      reason: 'lan.host must be one concrete interface address; binding every interface would expose the bridge on all networks',
    };
  }
  // 拒绝回环：绑回环等于没做这件事（DSH 已经绑了回环）。
  if (/^127\./.test(trimmedHost) || trimmedHost === 'localhost') {
    return {
      ok: false,
      reason: 'lan.host is a loopback address; that adds nothing over the existing webServer route',
    };
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmedHost)) {
    return { ok: false, reason: `lan.host must be an IPv4 literal, got ${JSON.stringify(trimmedHost)}` };
  }

  const numericPort = typeof port === 'number' ? port : Number.parseInt(String(port ?? ''), 10);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    return { ok: false, reason: `lan.port must be an integer in 1..65535, got ${JSON.stringify(port)}` };
  }

  if (typeof token !== 'string' || token.trim().length < 16) {
    return {
      ok: false,
      reason: 'lan.token is required (at least 16 characters); an unauthenticated listener on a LAN address would expose DSH tools to every device on the network',
    };
  }

  return { ok: true, host: trimmedHost, port: numericPort, token: token.trim() };
}

/**
 * 启动局域网监听。
 *
 * 这个监听**只做一件事**：把进来的请求交给同一个桥 handler。
 * 它不做路径转换、不做协议转换，因此与主桥的行为必然一致
 * （这也是为什么两者的测试可以共用同一批用例）。
 *
 * @param {object} options - 启动参数。
 * @param {string} options.host - 绑定的 IPv4。
 * @param {number} options.port - 端口。
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} options.handler - 桥的请求处理器。
 * @param {(message: string) => void} [options.log] - 日志回调。
 * @returns {Promise<{ok: true, close: () => Promise<void>, address: {host: string, port: number}} | {ok: false, reason: string}>}
 */
export async function startLanListener({ host, port, handler, log }) {
  const server = createServer((req, res) => {
    // 兜底：handler 抛错绝不能让进程崩，也不能让连接悬挂。
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((err) => {
        try {
          if (!res.writableEnded) {
            const body = Buffer.from(JSON.stringify({
              ok: false,
              error: { code: ERROR_CODE.INTERNAL, message: err instanceof Error ? err.message : String(err) },
            }));
            res.writeHead(500, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': String(body.length),
              'x-dsh-bridge-protocol': String(PROTOCOL_VERSION),
            });
            res.end(body);
          }
        } catch {
          /* 响应已经不可写，只能放弃 */
        }
      });
  });

  /** 记录所有活动连接，close() 时要强制断开，否则 keep-alive 会让 close 挂住。 */
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const outcome = await new Promise((resolve) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      const code = err && typeof err === 'object' ? err.code : undefined;
      if (code === 'EADDRINUSE') {
        resolve({ ok: false, reason: `lan.port ${port} is already in use on ${host}` });
      } else if (code === 'EADDRNOTAVAIL') {
        resolve({ ok: false, reason: `${host} is not an address of this machine (lan.host is wrong or the interface is down)` });
      } else if (code === 'EACCES') {
        resolve({ ok: false, reason: `permission denied binding ${host}:${port} (ports below 1024 need elevation)` });
      } else {
        resolve({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve({ ok: true });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  if (!outcome.ok) {
    server.close();
    return outcome;
  }

  log?.(`dsh-mobile-bridge: LAN listener bound to http://${host}:${port}`);

  return {
    ok: true,
    address: { host, port },
    /**
     * 关闭监听。先断开所有 socket，再 close，否则 keep-alive 连接会让它一直等。
     *
     * @returns {Promise<void>}
     */
    async close() {
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          /* 已断开 */
        }
      }
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
