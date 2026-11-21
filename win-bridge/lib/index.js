/**
 * dsh-mobile-bridge —— Host 入口
 *
 * 给 RikkaHub（Android）和 DSH（Windows）之间架一座**双向工具桥**。
 *
 * 为什么不用 MCP（实测结论，见 project-docs/PROTOCOL_SPEC.md）：
 * DSH 0.2.2-rc.5 运行时只打包了 `@modelcontextprotocol/client`，
 * `server` 根本不存在，所以「把 DSH 工具暴露成 MCP Server」这条路走不通。
 * 因此这里不套协议，只在 DSH 自己的 webServer 上挂一组小端点。
 *
 * 两个方向：
 *  - **出**：`GET <base>/tools` 列出 DSH 可见工具，`POST <base>/tools/call` 执行。
 *    手机从这里发现并调用电脑能力。
 *  - **入**：手机把自己的工具清单 POST 到 `<base>/register`，桥把它们
 *    包装成 `defineTool()` 注册进 `ctx.tools`，模型从此能调手机工具。
 *
 * 安全模型（默认最保守）：
 *  - 插件默认 `enabled: false`，必须显式开启才会挂载端点；
 *  - 工具执行走 `ctx.tools.execute()`，因此 DSH 自己的审批/守卫流水线
 *    照常生效，桥不是审批旁路；
 *  - 入方向注册进来的工具名一律 `mcp__<node>__<tool>` 前缀，
 *    继承 RikkaHub 侧对 MCP 工具默认要求人工批准的约定；
 *  - 所有请求都受跳数预算约束，防止 A→B→A 循环调用。
 *
 * @module dsh-mobile-bridge
 */

import {
  PROTOCOL_VERSION,
  ERROR_CODE,
  HEADER,
  newTraceId,
  parseTrace,
  checkHopBudget,
  okEnvelope,
  errorEnvelope,
  validateWireTool,
  qualifyToolName,
} from './protocol.js';
import { toolSchemaToWire, wireParametersToSpec } from './schema.js';
import { callRemoteTool, fetchRemoteTools } from './client.js';
import { handleMessage as handleMcpMessage, RPC_ERROR, rpcError } from './mcp.js';
import { startLanListener, validateLanOptions } from './lan.js';
import {
  newCompletionId,
  chunkToSse,
  SSE_DONE,
  sseFrame,
  openAiRequestToGenerateOptions,
  normalizeUsage,
  mapFinishReason,
  extractFinishError,
  friendlyLlmError,
  preprocessingImages,
} from './llm.js';

/**
 * 流中途出错时的 SSE 错误帧（OpenAI 没有标准错误帧，用 finish_reason 表达）。
 *
 * @param {string} id - completion id。
 * @param {string} model - 模型名。
 * @param {string} message - 错误说明。
 * @returns {string}
 */
function sseFrameForError(id, model, message) {
  // 把错误写进 content，并保证流以 stop 收尾 —— 严格客户端也能消费。
  return sseFrame({
    id,
    model,
    delta: { role: 'assistant', content: `[bridge error] ${message}` },
    finishReason: 'stop',
  });
}

/**
 * mapFinishReason 的安全包装（永不抛）。
 *
 * @param {unknown} reason - DSH finish reason。
 * @returns {string}
 */
function mapFinishReasonSafe(reason) {
  try {
    return mapFinishReason(reason);
  } catch {
    return 'stop';
  }
}

/** 插件身份。 */
export const name = 'dsh-mobile-bridge';

/**
 * 依赖注入：webServer 挂端点，tools 读写工具注册表，llm 用于模型门面。
 *
 * tools/webServer 是必需的；llm 是可选的 —— 如果 profile 没挂 llm 服务，
 * 工具桥照常工作，只是 `/llm/*` 端点返回 503。这样降级比整个插件起不来好。
 */
export const inject = ['webServer', 'tools', 'llm'];

/**
 * 请求体上限，防止对端一上来就灌爆内存。
 *
 * 但**不能太小**：手机侧模型若开启「图片输入」，历史里的截图会以
 * base64 打进请求，单张 1164×2560 的截图 base64 后就有 1~3 MB。
 * 实测一个正常长对话本身已 326 KB，再加一张图就会超过旧上限 512 KB，
 * 于是桥回 413、客户端只看到 "unexpected end of stream"
 * （而且 413 分支在更早的代码路径上，不写 LLM 诊断，极难排查）。
 *
 * 32 MB 足够容纳多张截图的上下文，同时仍是有限值。
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * 动态取 `defineTool`：宿主里有就用真的（带 schema 校验），
 * 脱宿主跑测试时退化成恒等函数。
 */
let defineTool = (def) => def;
try {
  const mod = await import('@deepseek-ai/dsh-tools');
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool;
} catch {
  /* 宿主外运行：保持恒等实现 */
}

/**
 * 读满一个请求体，超过上限立刻中止。
 *
 * 不用 `for await` 收集，是因为需要在超限的第一时间停止读取并断开，
 * 而不是把整个垃圾流读完再判断。
 *
 * @param {import('node:http').IncomingMessage} req - HTTP 请求。
 * @param {number} limit - 字节上限。
 * @returns {Promise<{ok: true, text: string} | {ok: false, reason: string}>}
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > limit) {
        finish({ ok: false, reason: `request body exceeds ${limit} bytes` });
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', (err) => finish({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
  });
}

/**
 * 发一个 JSON 响应。带 `no-store`，因为响应里可能含工作区内容。
 *
 * @param {import('node:http').ServerResponse} res - HTTP 响应。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - 要序列化的对象。
 */
function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-dsh-bridge-protocol': String(PROTOCOL_VERSION),
  });
  res.end(body);
}

/**
 * 把 DSH `ToolExecutionResult` 投影成 wire 上的结果。
 *
 * DSH 的失败结果自带 `error` 对象和面向模型的 `content`，这里两者都保留：
 * 手机侧既需要判断成功与否，也需要拿到可读的说明。
 *
 * @param {import('@deepseek-ai/dsh-tools').ToolExecutionResult} result - 单次执行结果。
 * @returns {{ok: boolean, content: unknown[], value?: unknown, error?: {code: string, message: string}}}
 */
function projectExecutionResult(result) {
  if (result === null || typeof result !== 'object') {
    return { ok: false, content: [], error: { code: ERROR_CODE.INTERNAL, message: 'tool executor returned no result' } };
  }
  if (result.isError === true) {
    const failure = result.error ?? {};
    const message = typeof failure.message === 'string' && failure.message !== ''
      ? failure.message
      : 'tool execution failed';
    return {
      ok: false,
      content: Array.isArray(result.content) ? result.content : [],
      error: {
        code: typeof failure.code === 'string' && failure.code !== '' ? failure.code : ERROR_CODE.TOOL_FAILED,
        message,
      },
    };
  }
  return {
    ok: true,
    content: Array.isArray(result.content) ? result.content : [],
    value: result.value ?? null,
  };
}

/**
 * 从 `ctx.tools` 当前可见集合里取出可对外暴露的工具清单。
 *
 * 只取全局视图（不传 scope），因为桥是部署级能力，不是某个 agent 的私产。
 * 刻意**排除**本桥自己注册进来的远端工具，否则手机的工具会被原样
 * 回显给手机，形成自我循环。
 *
 * @param {object} tools - `ctx.tools`。
 * @param {string} marker - 用于识别「本桥注册的工具」的前缀。
 * @returns {object[]} wire 格式的工具描述数组。
 */
function listExposedTools(tools, marker) {
  let definitions = [];
  try {
    definitions = tools.definitions() ?? [];
  } catch {
    definitions = [];
  }
  const exposed = [];
  for (const definition of definitions) {
    const toolName = definition?.name;
    if (typeof toolName !== 'string' || toolName === '') continue;
    if (toolName.startsWith(marker)) continue;
    exposed.push(toolSchemaToWire({
      name: toolName,
      description: definition.description,
      parameters: definition.parameters,
    }));
  }
  return exposed;
}

/**
 * 挂载插件。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {object} [config] - 插件配置。
 * @param {boolean} [config.enabled] - 是否真的挂端点；默认 false。
 * @param {string} [config.listenPath] - 端点前缀，默认 `/dsh-mobile-bridge`。
 * @param {string} [config.selfNodeId] - 本节点标识，出现在 trace 头里。
 * @param {string} [config.token] - 可选的共享令牌；设置后所有请求必须带 `Authorization: Bearer <token>`。
 * @param {number} [config.timeoutMs] - 单次工具执行超时，默认 120 秒。
 */
export function apply(ctx, config) {
  const cfg = config ?? {};

  // 默认关闭：端点一旦挂上就是局域网可达的攻击面。
  if (cfg.enabled !== true) {
    ctx.logger?.info?.('dsh-mobile-bridge: disabled (set `enabled: true` to mount the endpoints)');
    return;
  }

  const basePathRaw = typeof cfg.listenPath === 'string' && cfg.listenPath.trim() !== ''
    ? cfg.listenPath.trim()
    : '/dsh-mobile-bridge';
  // webServer 要求路径无尾斜杠，这里统一抹掉，避免注册期就抛错。
  const basePath = basePathRaw.replace(/\/+$/, '') || '/dsh-mobile-bridge';
  const selfNodeId = typeof cfg.selfNodeId === 'string' && cfg.selfNodeId.trim() !== ''
    ? cfg.selfNodeId.trim()
    : 'windows-dsh';
  const token = typeof cfg.token === 'string' && cfg.token.trim() !== '' ? cfg.token.trim() : null;
  const timeoutMs = typeof cfg.timeoutMs === 'number' && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
    ? Math.min(Math.round(cfg.timeoutMs), 600_000)
    : 120_000;

  /**
   * 独立监听配置（可选），支持多个地址。
   *
   * 两种写法都兼容：
   *   单条: lan: { host: '192.168.1.3', port: 61420, token: '...' }
   *   多条: lan: [ { host: '192.168.1.3', ... }, { host: '100.91.212.5', ... } ]
   *
   * 多监听的意义：局域网一条 + Tailscale/EasyTier 一条，
   * 手机不在家时走隧道照样能用（两者只是 IP 不同，端点与鉴权完全一样）。
   */
  const lanConfigRaw = cfg.lan;
  const lanConfigs = Array.isArray(lanConfigRaw)
    ? lanConfigRaw
    : (lanConfigRaw !== null && typeof lanConfigRaw === 'object' ? [lanConfigRaw] : []);

  /** 所有局域网监听句柄，卸载时统一关闭。 */
  const lanListeners = [];

  /** 本桥注册的工具名前缀，用于把它们从「可暴露清单」里排除。 */
  const REGISTERED_MARKER = 'mcp__';

  /** 入方向注册的 disposer 表，卸载时统一回收。 */
  const registeredDisposers = [];

  /**
   * 远端节点登记表：node 标识 → `{ baseUrl, token }`。
   *
   * 入方向注册的工具在执行时要回到提供它的节点，所以必须记住
   * 这个节点当时是从哪个地址、用哪个令牌注册上来的。
   *
   * @type {Map<string, {baseUrl: string | null, token: string | null}>}
   */
  const remoteNodes = new Map();

  /** 已注册工具名 → 提供它的节点与原始工具名。 */
  const toolOwners = new Map();

  /** 最近一次模型调用的 chunk 统计（排障：看 DSH 到底吐了什么）。 */
  let lastLlmChunks = null;

  /** 最近一次模型请求的结构元数据（只记角色/长度/工具数，不记正文）。 */
  let lastLlmRequest = null;

  /** 最近一次模型调用抛出的错误（流式 catch 路径，排障关键）。 */
  let lastLlmError = null;

  /** 最近一次流式调用的进展（区分"流没开始"与"中途断开"）。 */
  let lastLlmProgress = null;

  /**
   * 最近一次**失败**请求的结构快照。
   *
   * lastLlmRequest 每次请求都会覆盖，成功的请求会把失败记录冲掉
   * （实战踩到：用户报错后我一查，看到的是紧随其后那次成功请求的数据）。
   * 这个变量只在出错时写入，专门保留失败现场。
   */
  let lastFailedRequest = null;

  /**
   * 调用审计：最近 N 次工具调用的记录。
   *
   * 用途有二：
   *  1. 排障 —— 手机说「调不动」时能立刻分清是没连上、还是工具本身报错；
   *  2. 证明 —— 「看见工具」和「真的调过」是两件事，这里是后者的证据。
   *
   * 只记元数据（工具名、成功与否、耗时、来源 IP），**不记参数与结果**，
   * 因为参数里可能带路径、正文甚至凭据。
   *
   * @type {Array<{at: string, tool: string, ok: boolean, ms: number, via: string, peer: string, errorCode?: string}>}
   */
  const recentCalls = [];
  const RECENT_CALLS_LIMIT = 50;

  /**
   * 记一条调用审计。超出上限时丢最旧的。
   *
   * @param {{tool: string, ok: boolean, ms: number, via: string, peer: string, errorCode?: string}} entry - 审计项。
   */
  const recordCall = (entry) => {
    recentCalls.push({ at: new Date().toISOString(), ...entry });
    while (recentCalls.length > RECENT_CALLS_LIMIT) recentCalls.shift();
  };

  /**
   * 鉴权。没配 token 时视为「已在可信网络内」，与 DSH 自身 webServer
   * 不做认证的现状保持一致 —— 真正的边界由外层网关（局域网 TLS / 隧道）提供。
   *
   * @param {import('node:http').IncomingMessage} req - HTTP 请求。
   * @returns {{ok: true} | {ok: false, reason: string}}
   */
  /**
   * 构造一个鉴权器。
   *
   * **为什么要参数化**：局域网独立监听必须用自己的 token，不能复用主 token ——
   * 否则「独立监听用独立凭据」这个安全设计就落空了。
   * 没配 token 时视为「已在可信网络内」，与 DSH 自身 webServer 的现状一致。
   *
   * @param {string | null} expectedToken - 该入口接受的令牌，null 表示不鉴权。
   * @returns {(req: import('node:http').IncomingMessage) => {ok: true} | {ok: false, reason: string}}
   */
  const makeAuthorizer = (expectedToken) => (req) => {
    if (expectedToken === null) return { ok: true };
    const raw = req.headers[HEADER.AUTHORIZATION];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') return { ok: false, reason: 'missing Authorization header' };
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    if (match === null) return { ok: false, reason: 'Authorization must be `Bearer <token>`' };
    // 长度不等直接拒绝，避免逐字符比较泄露长度信息。
    const given = match[1];
    if (given.length !== expectedToken.length) return { ok: false, reason: 'invalid token' };
    let diff = 0;
    for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ expectedToken.charCodeAt(i);
    return diff === 0 ? { ok: true } : { ok: false, reason: 'invalid token' };
  };

  /** 主入口（webServer 回环）的鉴权器。 */
  const authorize = makeAuthorizer(token);

  /**
   * 统一的入站前处理：鉴权 + 跳数预算。
   *
   * @param {import('node:http').IncomingMessage} req - HTTP 请求。
   * @param {import('node:http').ServerResponse} res - HTTP 响应。
   * @returns {{ok: true, trace: object} | {ok: false}}
   */
  /**
   * 统一的入站前处理：鉴权 + 跳数预算。
   *
   * @param {import('node:http').IncomingMessage} req - HTTP 请求。
   * @param {import('node:http').ServerResponse} res - HTTP 响应。
   * @param {(req: import('node:http').IncomingMessage) => {ok: true} | {ok: false, reason: string}} [checks] - 用哪套鉴权，缺省用主入口的。
   * @returns {{ok: true, trace: object} | {ok: false}}
   */
  const preflight = (req, res, checks = authorize) => {
    const auth = checks(req);
    if (!auth.ok) {
      sendJson(res, 401, errorEnvelope(ERROR_CODE.UNAUTHORIZED, auth.reason));
      return { ok: false };
    }
    const trace = parseTrace(req.headers);
    const budget = checkHopBudget(trace);
    if (!budget.ok) {
      sendJson(res, 508, errorEnvelope(budget.code, budget.reason, { hopCount: trace.hopCount }));
      return { ok: false };
    }
    return { ok: true, trace };
  };

  /**
   * 统一的工具执行：两个端点（原生 `/tools/call` 与 MCP `/mcp`）共用。
   *
   * 关键：走 `ctx.tools.execute()`，**不是审批旁路** —— DSH 的
   * pre-execute → guards → execute → post-execute 流水线照常生效。
   *
   * @param {string} toolName - 工具名。
   * @param {unknown} args - 参数。
   * @param {import('node:http').ServerResponse} res - 用于在客户端断开时取消。
   * @param {import('node:http').IncomingMessage} [req] - 请求，用于记来源 IP。
   * @param {string} [via] - 从哪个端点来的（`native` / `mcp`），便于排障。
   * @returns {Promise<{ok: boolean, value?: unknown, content: unknown[], error?: {code: string, message: string}}>}
   */
  const executeTool = async (toolName, args, res, req, via = 'native') => {
    const callId = `bridge-${newTraceId()}`;
    const startedAt = Date.now();
    const peer = (() => {
      const addr = req?.socket?.remoteAddress;
      if (typeof addr !== 'string') return 'unknown';
      // IPv4-mapped IPv6 归一，避免 ::ffff:192.168.1.5 这种看着吓人
      return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    })();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('bridge tool timeout')), timeoutMs);
    // 对端断开时立刻取消，别让工具在后台瞎跑。
    res.on('close', () => controller.abort(new Error('client disconnected')));

    try {
      const batch = await ctx.tools.execute({
        calls: [{
          type: 'tool-call',
          id: callId,
          name: toolName,
          arguments: JSON.stringify(args ?? {}),
        }],
        signal: controller.signal,
      });
      const first = Array.isArray(batch?.results) ? batch.results[0] : undefined;
      if (first === undefined) {
        recordCall({ tool: toolName, ok: false, ms: Date.now() - startedAt, via, peer, errorCode: ERROR_CODE.INTERNAL });
        return {
          ok: false,
          content: [],
          error: { code: ERROR_CODE.INTERNAL, message: 'tool executor returned no result for the call' },
        };
      }
      const projected = projectExecutionResult(first.result);
      recordCall({
        tool: toolName,
        ok: projected.ok,
        ms: Date.now() - startedAt,
        via,
        peer,
        ...(projected.ok ? {} : { errorCode: projected.error?.code }),
      });
      return projected;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = controller.signal.aborted ? ERROR_CODE.TIMEOUT : ERROR_CODE.TOOL_FAILED;
      recordCall({ tool: toolName, ok: false, ms: Date.now() - startedAt, via, peer, errorCode: code });
      return {
        ok: false,
        content: [],
        error: {
          code,
          message,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  };

  /** @type {Array<() => void>} */
  const disposers = [];

  // ---------------------------------------------------------------- 出方向

  /**
   * 构造桥的请求处理器。
   *
   * **刻意抽成工厂**：主 webServer 路由与局域网监听共用同一份实现，
   * 因此两者的**行为**必然一致（不会出现「回环能用、局域网行为不同」的漂移），
   * 但各自可以用**不同的鉴权令牌**。
   *
   * @param {(req: import('node:http').IncomingMessage) => {ok: true} | {ok: false, reason: string}} checks - 该入口的鉴权器。
   * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
   */
  const makeBridgeHandler = (checks) => async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://bridge.invalid');
      const tail = url.pathname.slice(basePath.length).replace(/\/+$/, '');

      if (tail === '/tools' && req.method === 'GET') {
        const gate = preflight(req, res, checks);
        if (!gate.ok) return;
        const tools = listExposedTools(ctx.tools, REGISTERED_MARKER);
        sendJson(res, 200, okEnvelope({
          protocolVersion: PROTOCOL_VERSION,
          nodeId: selfNodeId,
          tools,
        }));
        return;
      }

      if (tail === '/health' && req.method === 'GET') {
        sendJson(res, 200, okEnvelope({
          protocolVersion: PROTOCOL_VERSION,
          nodeId: selfNodeId,
          authRequired: token !== null,
        }));
        return;
      }

      if (tail === '/tools/call' && req.method === 'POST') {
        const gate = preflight(req, res, checks);
        if (!gate.ok) return;

        const body = await readBody(req, MAX_BODY_BYTES);
        if (!body.ok) {
          sendJson(res, 413, errorEnvelope(ERROR_CODE.PAYLOAD_TOO_LARGE, body.reason));
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(body.text);
        } catch {
          sendJson(res, 400, errorEnvelope(ERROR_CODE.BAD_REQUEST, 'request body is not valid JSON'));
          return;
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendJson(res, 400, errorEnvelope(ERROR_CODE.BAD_REQUEST, 'request body must be a JSON object'));
          return;
        }

        const toolName = typeof parsed.tool === 'string' ? parsed.tool.trim() : '';
        if (toolName === '') {
          sendJson(res, 400, errorEnvelope(ERROR_CODE.BAD_REQUEST, 'missing `tool`'));
          return;
        }
        // 不允许通过桥调用本桥注册的远端工具：那会让请求绕回自己。
        if (toolName.startsWith(REGISTERED_MARKER)) {
          sendJson(res, 403, errorEnvelope(
            ERROR_CODE.FORBIDDEN,
            'refusing to dispatch a bridge-registered remote tool through the bridge (loop guard)',
          ));
          return;
        }

        const args = parsed.arguments === undefined ? {} : parsed.arguments;
        const projected = await executeTool(toolName, args, res, req, 'native');
        sendJson(res, projected.ok ? 200 : 502, {
          ok: projected.ok,
          traceId: gate.trace.traceId,
          result: projected.ok ? projected.value : undefined,
          content: projected.content,
          error: projected.ok ? undefined : projected.error,
        });
        return;
      }

      // ------------------------------------------------------------ 入方向

      if (tail === '/register' && req.method === 'POST') {
        const gate = preflight(req, res, checks);
        if (!gate.ok) return;

        const body = await readBody(req, MAX_BODY_BYTES);
        if (!body.ok) {
          sendJson(res, 413, errorEnvelope(ERROR_CODE.PAYLOAD_TOO_LARGE, body.reason));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body.text);
        } catch {
          sendJson(res, 400, errorEnvelope(ERROR_CODE.BAD_REQUEST, 'request body is not valid JSON'));
          return;
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendJson(res, 400, errorEnvelope(ERROR_CODE.BAD_REQUEST, 'request body must be a JSON object'));
          return;
        }

        const nodeSlug = typeof parsed.node === 'string' ? parsed.node.trim() : '';
        if (nodeSlug === '') {
          sendJson(res, 400, errorEnvelope(ERROR_CODE.BAD_REQUEST, 'missing `node`'));
          return;
        }
        const rawTools = Array.isArray(parsed.tools) ? parsed.tools : [];
        if (rawTools.length > 200) {
          sendJson(res, 400, errorEnvelope(ERROR_CODE.BAD_REQUEST, 'too many tools in one registration (limit 200)'));
          return;
        }
        // 节点回连地址：注册方必须提供，否则注册进来的工具执行时无路可走。
        const nodeBaseUrlRaw = typeof parsed.baseUrl === 'string' ? parsed.baseUrl.trim() : '';
        if (nodeBaseUrlRaw === '') {
          sendJson(res, 400, errorEnvelope(ERROR_CODE.BAD_REQUEST, 'missing `baseUrl` (the node must be reachable for callback)'));
          return;
        }
        if (!/^https?:\/\//i.test(nodeBaseUrlRaw)) {
          sendJson(res, 400, errorEnvelope(ERROR_CODE.BAD_REQUEST, '`baseUrl` must be an absolute http(s) URL'));
          return;
        }
        const nodeToken = typeof parsed.token === 'string' && parsed.token.trim() !== ''
          ? parsed.token.trim()
          : null;

        const accepted = [];
        const rejected = [];
        for (const raw of rawTools) {
          const verdict = validateWireTool(raw);
          if (!verdict.ok) {
            rejected.push({ name: raw?.name ?? null, reason: verdict.reason });
            continue;
          }
          const localName = qualifyToolName(nodeSlug, verdict.tool.name);
          const { spec, lossy } = wireParametersToSpec(verdict.tool.parameters);
          const remoteToolName = verdict.tool.name;

          // 同名重注册：先撤旧的，否则 tools.register 会因冲突整批失败。
          const previous = toolOwners.get(localName);
          if (previous !== undefined && typeof previous.dispose === 'function') {
            try {
              previous.dispose();
            } catch {
              /* 旧注册收回失败不阻断新注册 */
            }
            toolOwners.delete(localName);
          }

          try {
            const dispose = ctx.tools.register(defineTool({
              name: localName,
              description: verdict.tool.description !== ''
                ? verdict.tool.description
                : `Remote tool \`${remoteToolName}\` on node \`${nodeSlug}\`.`,
              parameters: spec,
              output: {
                schema: { type: 'json' },
                render: (_args, value) => [{
                  type: 'text',
                  text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2),
                }],
              },
              async execute(args, exec) {
                const owner = remoteNodes.get(nodeSlug);
                if (owner === undefined || owner.baseUrl === null) {
                  throw new Error(
                    `remote node \`${nodeSlug}\` is not registered; cannot reach tool \`${remoteToolName}\``,
                  );
                }
                const outcome = await callRemoteTool({
                  baseUrl: owner.baseUrl,
                  selfNodeId,
                  targetNodeId: nodeSlug,
                  tool: remoteToolName,
                  args,
                  trace: { traceId: newTraceId(), hopCount: 0 },
                  token: owner.token,
                  signal: exec?.signal,
                  timeoutMs,
                });
                if (!outcome.ok) {
                  // 抛出而不是返回错误值：让 DSH 的失败流水线接管，
                  // 保住「失败结果带结构化错误」的语义。
                  throw new Error(`${outcome.code}: ${outcome.message}`);
                }
                return outcome.value;
              },
            }));
            toolOwners.set(localName, { nodeSlug, remoteToolName, dispose });
            registeredDisposers.push(dispose);
            accepted.push({ name: localName, lossy });
          } catch (err) {
            rejected.push({
              name: verdict.tool.name,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (accepted.length > 0) {
          remoteNodes.set(nodeSlug, { baseUrl: nodeBaseUrlRaw.replace(/\/+$/, ''), token: nodeToken });
        }

        sendJson(res, 200, okEnvelope({
          node: nodeSlug,
          accepted,
          rejected,
        }));
        return;
      }

      // ------------------------------------------------------- 模型门面
      //
      // OpenAI 兼容的 /v1/chat/completions，让 RikkaHub 用现成的
      // OpenAIProvider 就能调电脑上的模型（WorkBuddy 等）。手机侧零代码。
      if (tail === '/llm/v1/chat/completions' && req.method === 'POST') {
        const gate = preflight(req, res, checks);
        if (!gate.ok) return;

        if (ctx.llm === undefined || typeof ctx.llm.stream !== 'function') {
          sendJson(res, 503, errorEnvelope(ERROR_CODE.INTERNAL, 'llm service is not available in this profile'));
          return;
        }

        const body = await readBody(req, MAX_BODY_BYTES);
        if (!body.ok) {
          // 这条分支在 LLM 处理之前，必须显式记录，
          // 否则客户端只看到 "unexpected end of stream"，诊断里一片空白
          // （实测：图片把请求体撑到上限导致的 413 就是这么被漏掉的）。
          lastLlmError = {
            at: new Date().toISOString(),
            model: '(unknown)',
            raw: `request body rejected: ${body.reason}`,
            name: 'PayloadTooLarge',
            friendly: `请求体过大（上限 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB），已在读取阶段拒绝`,
            clientAborted: false,
            progress: null,
          };
          sendJson(res, 413, errorEnvelope(ERROR_CODE.PAYLOAD_TOO_LARGE, body.reason));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body.text);
        } catch {
          sendJson(res, 400, errorEnvelope(ERROR_CODE.BAD_REQUEST, 'request body is not valid JSON'));
          return;
        }
        // 图片预处理：把 image_url 换 DSH 的 ImageBlock（真正让模型看图）。
        // 必须在同步转换之前做，因为 saveImages 是异步的。
        // 没有附件服务时自动退化成文字占位，不影响其它块。
        const attachmentsService = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined;
        let savedImages = 0;
        try {
          savedImages = await preprocessingImages(parsed, attachmentsService);
        } catch (e) {
          lastLlmError = {
            at: new Date().toISOString(),
            model: '(unknown)',
            raw: `image preprocessing failed: ${e instanceof Error ? e.message : String(e)}`,
            name: 'ImagePreprocessFailed',
            friendly: '处理图片时出错，已退回文字占位',
            clientAborted: false,
            progress: null,
          };
        }
        const converted = openAiRequestToGenerateOptions(parsed);
        if (!converted.ok) {
          sendJson(res, 400, errorEnvelope(ERROR_CODE.BAD_REQUEST, converted.reason));
          return;
        }
        // 记录请求结构（不含正文）：便于对比"测试 OK"与"真机 400"的差异。
        lastLlmRequest = {
          at: new Date().toISOString(),
          model: converted.options.model,
          provider: converted.options.provider,
          roles: (converted.options.messages ?? []).map((m) => m.role),
          contentLengths: (converted.options.messages ?? []).map((m) =>
            Array.isArray(m.content) ? m.content.map((b) => (typeof b.text === 'string' ? b.text.length : 0)) : 0),
          hasSystem: typeof converted.options.system === 'string',
          toolCount: Array.isArray(converted.options.tools) ? converted.options.tools.length : 0,
          droppedTools: converted.droppedTools ?? 0,
          // 请求体规模：体积过大可能被上游/网关直接拒绝（表现为「立刻断开」）。
          bodyBytes: body.text.length,
          totalContentChars: (converted.options.messages ?? []).reduce(
            (sum, m) => sum + (Array.isArray(m.content)
              ? m.content.reduce((s, b) => s + (typeof b.text === 'string' ? b.text.length : 0), 0)
              : 0), 0),
          // 工具名列表：不同模型对某些工具名/描述可能不兼容
          // （实测 workbuddy 会拒绝非 ASCII 工具名），排障时需要看全量。
          toolNames: (converted.options.tools ?? []).map((t) => t.name),
          savedImages,
          maxTokens: converted.options.maxTokens,
          adjustedMaxTokens: converted.adjustedMaxTokens,
        };

        const id = newCompletionId();
        const modelName = converted.options.model;
        const wantsStream = parsed.stream !== false; // OpenAI 缺省是流式；显式 stream:false 才关闭

        // 客户端断开时中止模型调用。
        // 注意：Node 的 'close' 在响应**正常结束**后也会触发，
        // 所以用 res.writableEnded 区分"客户端提前断开"与"已正常写完"：
        // 已写完就没必要（也不应该）再 abort，否则可能在流收尾阶段
        // 抛 AbortError，让客户端看到 truncated 的响应。
        const controller = new AbortController();
        res.on('close', () => {
          if (!res.writableEnded) controller.abort();
        });

        if (wantsStream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-dsh-bridge-protocol': String(PROTOCOL_VERSION),
          });
          /** @type {{roleSent: boolean, pendingUsage: object | undefined, finished: boolean, namedToolIds: Set<string>, reasoningBuffer: string, hasText: boolean, hasToolCall: boolean}} */
          const state = {
            roleSent: false, pendingUsage: undefined, finished: false,
            namedToolIds: new Set(), reasoningBuffer: '', hasText: false, hasToolCall: false,
          };
          // 所有帧共享同一个 ctx 对象：reasoningBuffer / namedToolIds / hasText / hasToolCall
          // 必须跨帧累积，否则思考兜底与 tool name 去重都会失效。
          const sseCtx = {
            id, model: modelName,
            get roleSent() { return state.roleSent; },
            set roleSent(v) { state.roleSent = v; },
            get pendingUsage() { return state.pendingUsage; },
            set pendingUsage(v) { state.pendingUsage = v; },
            get namedToolIds() { return state.namedToolIds; },
            get reasoningBuffer() { return state.reasoningBuffer; },
            set reasoningBuffer(v) { state.reasoningBuffer = v; },
            get hasText() { return state.hasText; },
            set hasText(v) { state.hasText = v; },
            get hasToolCall() { return state.hasToolCall; },
            set hasToolCall(v) { state.hasToolCall = v; },
          };
          try {
            let chunkSeq = 0;
            /** 记录本次流的进展，异常时能定位断在哪一步。 */
            const progress = { started: false, chunks: 0, firstTypes: [], lastType: null, aborted: false };
            lastLlmProgress = progress;
            // 探针：区分"调用 stream() 时就同步抛错"与"迭代过程中抛错"。
            // 用户症状是「点发送后几乎立刻报错」，很可能死在建立阶段。
            let iterable;
            try {
              iterable = ctx.llm.stream({ ...converted.options, signal: controller.signal });
              progress.streamCreated = true;
            } catch (syncErr) {
              progress.syncThrow = true;
              progress.syncError = syncErr instanceof Error ? syncErr.message : String(syncErr);
              throw syncErr;
            }
            for await (const chunk of iterable) {
              progress.started = true;
              progress.chunks = ++chunkSeq;
              progress.lastType = chunk?.type ?? 'unknown';
              if (progress.firstTypes.length < 5) progress.firstTypes.push(chunk?.type ?? 'unknown');
              const out = chunkToSse(chunk, sseCtx);
              for (const frame of out.frames) res.write(frame);
              if (out.finishReason !== null) state.finished = true;
            }
            progress.completed = true;
            // 兜底：如果流结束时 DSH 没有发 finish 帧，我们补一个，
            // 否则客户端会一直等 [DONE]。
            if (!state.finished) {
              for (const frame of chunkToSse({ type: 'finish', reason: 'stop' }, sseCtx).frames) res.write(frame);
            }
            // **空响应保护**：上游有时只返回 usage+finish，没有任何
            // block-start / text-delta（实测 deepseek-v4-pro 在长会话下会这样）。
            // 此时客户端收不到任何正文，只看到连接结束 → 报
            // "unexpected end of stream" 并自动重试，用户完全不知道原因。
            // 这里补一条明确的中文错误帧，让失败可见、可操作。
            if (!sseCtx.hasText && sseCtx.hasToolCall !== true) {
              lastLlmError = {
                at: new Date().toISOString(),
                model: modelName,
                raw: 'upstream returned no content (usage+finish only)',
                friendly: '模型返回了空内容',
                clientAborted: controller.signal.aborted,
                progress: lastLlmProgress,
              };
              lastFailedRequest = lastLlmRequest;
              res.write(sseFrameForError(
                id,
                modelName,
                '模型返回了空内容（上游只发了结束信号，没有任何正文或工具调用）。'
                + '这通常是该模型在当前对话长度/工具数量下不适用，'
                + '请换一个模型，或新建对话重试。',
              ));
            }
            res.write(SSE_DONE);
          } catch (err) {
            // 流中途出错：不能只写 [DONE]，客户端需要知道出错了。
            const raw = err instanceof Error ? err.message : String(err);
            const friendly = friendlyLlmError(raw);
            // 记录到诊断：这类"连接被中断"在客户端只表现为
            // "unexpected end of stream"，没有这层记录就无从排查。
            lastLlmError = {
              at: new Date().toISOString(),
              model: modelName,
              raw,
              name: err instanceof Error ? err.name : typeof err,
              friendly,
              clientAborted: controller.signal.aborted,
              progress: lastLlmProgress,
            };
            lastFailedRequest = lastLlmRequest;
            try {
              res.write(sseFrameForError(id, modelName, friendly));
              res.write(SSE_DONE);
              // 确保错误帧立刻发出：客户端在错误帧之前收到 EOF
              // 就会报 "unexpected end of stream"。
              if (typeof res.flush === 'function') res.flush();
            } catch (_writeFailed) {
              // 客户端可能已断开，忽略
            }
          } finally {
            res.end();
          }
          return;
        }

        // 非流式：收集所有分片，拼成一个完整的 chat.completion 响应。
        let content = '';
        let reasoning = '';
        let finishReason = 'stop';
        let usage;
        const toolCalls = [];
        /** @type {Record<string, number>} */
        const chunkCounts = {};
        let firstFinishReason = null;
        try {
          for await (const chunk of ctx.llm.stream({ ...converted.options, signal: controller.signal })) {
            const ct = chunk?.type ?? 'unknown';
            chunkCounts[ct] = (chunkCounts[ct] ?? 0) + 1;
            if (ct === 'finish' && firstFinishReason === null) firstFinishReason = chunk.reason ?? null;
            if (chunk?.type === 'text-delta') content += chunk.text ?? '';
            else if (chunk?.type === 'reasoning-delta') reasoning += chunk.text ?? '';
            else if (chunk?.type === 'tool-call-delta') {
              toolCalls.push({
                id: chunk.id ?? `call_${newTraceId()}`,
                type: 'function',
                function: {
                  name: chunk.name ?? '',
                  arguments: chunk.argumentsDelta ?? '',
                },
              });
            } else if (chunk?.type === 'usage') usage = normalizeUsage(chunk.usage);
            else if (chunk?.type === 'finish') {
              finishReason = mapFinishReasonSafe(chunk.reason);
              const errText = extractFinishError(chunk.reason);
              if (errText !== null) content += (content === '' ? '' : '\n') + `[模型错误] ${errText}`;
            }
          }
          lastLlmChunks = { model: modelName, chunks: chunkCounts, finishReason: firstFinishReason, contentLen: content.length, reasoningLen: reasoning.length };
          // 若整轮只有思考没有正文：绝不用思考冒充正文（那是英文推理泄漏）。
          // 有工具调用的轮次不插提示 —— 那是 agent 循环的中间轮，
          // 工具结果会驱动下一轮继续出正文。
          if (content === '' && reasoning !== '' && toolCalls.length === 0) {
            content = '（模型只输出了思考过程，没有生成正文。可尝试重新发送或更换模型。）';
          }
          // 空响应保护（与流式路径一致）：连思考都没有，说明上游真的返回空。
          if (content === '' && reasoning === '' && toolCalls.length === 0) {
            content = '模型返回了空内容（上游只发了结束信号，没有任何正文或工具调用）。'
              + '这通常是该模型在当前对话长度/工具数量下不适用，请换一个模型或新建对话重试。';
          }
          const message = { role: 'assistant', content };
          if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
            finishReason = 'tool_calls';
          }
          sendJson(res, 200, {
            id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{ index: 0, message, finish_reason: finishReason }],
            ...(usage !== undefined ? { usage } : {}),
          });
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          lastLlmError = {
            at: new Date().toISOString(),
            model: modelName,
            raw,
            name: err instanceof Error ? err.name : typeof err,
            friendly: friendlyLlmError(raw),
            clientAborted: controller.signal.aborted,
            progress: null,
          };
          lastFailedRequest = lastLlmRequest;
          sendJson(res, 502, errorEnvelope(ERROR_CODE.TOOL_FAILED, friendlyLlmError(raw)));
        }
        return;
      }

      // `GET <base>/v1/models` —— 让手机列出电脑上可用的模型。
      //
      // 关键：RikkaHub 的 OpenAIProvider.listModels()（OpenAIProvider.kt:78-86）
      // 会 GET <baseUrl>/models 自动拉取模型填进选择器。所以这里必须返回
      // **真正的 `provider/model` 组合**，而不是 provider 路由名 ——
      // 否则手机能连上但模型列表是空的，用户以为功能坏了。
      //
      // listModels(provider) 可能联网且较慢，逐个 try-catch + 并发，
      // 单个 provider 失败只跳过它，不影响其它 provider。
      if (tail === '/llm/v1/models' && req.method === 'GET') {
        const gate = preflight(req, res, checks);
        if (!gate.ok) return;
        if (ctx.llm === undefined || typeof ctx.llm.listProviders !== 'function'
          || typeof ctx.llm.listModels !== 'function') {
          sendJson(res, 503, errorEnvelope(ERROR_CODE.INTERNAL, 'llm service is not available in this profile'));
          return;
        }
        try {
          const providers = ctx.llm.listProviders() ?? [];
          const created = Math.floor(Date.now() / 1000);
          /** @type {Array<object>} */
          const models = [];

          // 并发拉每个 provider 的模型；全部 settle 后再汇总。
          await Promise.all(providers.map(async (provider) => {
            const key = typeof provider?.id === 'string' ? provider.id : '';
            if (key === '') return;
            const displayName = typeof provider?.name === 'string' && provider.name !== ''
              ? provider.name
              : key;
            try {
              const list = await ctx.llm.listModels(key) ?? [];
              for (const item of list) {
                const modelId = typeof item?.id === 'string' ? item.id : '';
                if (modelId === '') continue;
                // 拼成 provider/model —— 转换器正是按这个格式拆成两个字段的。
                models.push({
                  id: `${key}/${modelId}`,
                  object: 'model',
                  created,
                  owned_by: displayName,
                  // RikkaHub 的 Model 会读 name 作 displayName；这里额外带上原始字段。
                  name: typeof item?.name === 'string' && item.name !== '' ? item.name : modelId,
                });
              }
            } catch {
              // 某个 provider 的模型目录拉取失败（加密钥失效、网络不通等），
              // 跳过它即可。不虚构模型，也不让整个列表失败。
            }
          }));

          sendJson(res, 200, { object: 'list', data: models });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 502, errorEnvelope(ERROR_CODE.INTERNAL, message));
        }
        return;
      }

      // `GET <base>/diagnostics` —— 排障用：最近调用记录 + 环境事实。
      //
      // 回答「手机看得见工具，但到底调通过没有」这个最容易含糊的问题。
      // 只暴露元数据，不含参数、结果与任何凭据。
      if (tail === '/diagnostics' && req.method === 'GET') {
        const gate = preflight(req, res, checks);
        if (!gate.ok) return;
        const total = recentCalls.length;
        const succeeded = recentCalls.filter((c) => c.ok).length;
        sendJson(res, 200, okEnvelope({
          nodeId: selfNodeId,
          protocolVersion: PROTOCOL_VERSION,
          byVia: {
            native: recentCalls.filter((c) => c.via === 'native').length,
            mcp: recentCalls.filter((c) => c.via === 'mcp').length,
          },
          totals: { calls: total, succeeded, failed: total - succeeded },
          recent: recentCalls.slice(-20).reverse(),
          lan: lanListeners.map((listener) => listener.address),
          lastLlmChunks,
          lastLlmRequest,
          lastLlmError,
          lastLlmProgress,
          lastFailedRequest,
        }));
        return;
      }

      // `GET <base>/nodes` —— 让手机确认电脑记住了哪些节点（排障用）。
      if (tail === '/nodes' && req.method === 'GET') {
        const gate = preflight(req, res, checks);
        if (!gate.ok) return;
        sendJson(res, 200, okEnvelope({
          nodes: [...remoteNodes.entries()].map(([node, info]) => ({
            node,
            baseUrl: info.baseUrl,
            toolCount: [...toolOwners.values()].filter((owner) => owner.nodeSlug === node).length,
          })),
        }));
        return;
      }

      // ------------------------------------------------------- MCP 兼容端点
      //
      // 让 RikkaHub 的 McpManager **零代码**接入：
      // 手机的 StreamableHttpClientTransport 直接指向 `<base>/mcp` 即可。
      // 它比让手机实现本桥的私有协议省得多（手机侧现成有完整 MCP 客户端）。
      if (tail === '/mcp' && req.method === 'POST') {
        const gate = preflight(req, res, checks);
        if (!gate.ok) return;

        const body = await readBody(req, MAX_BODY_BYTES);
        if (!body.ok) {
          sendJson(res, 413, rpcError(null, RPC_ERROR.INVALID_REQUEST, body.reason));
          return;
        }

        let message;
        try {
          message = JSON.parse(body.text);
        } catch {
          sendJson(res, 200, rpcError(null, RPC_ERROR.PARSE_ERROR, 'request body is not valid JSON'));
          return;
        }

        // Streamable HTTP 允许批量（数组）请求。
        const isBatch = Array.isArray(message);
        const messages = isBatch ? message : [message];

        const responses = [];
        for (const one of messages) {
          const response = await handleMcpMessage(one, {
            listTools: () => listExposedTools(ctx.tools, REGISTERED_MARKER),
            callTool: async (toolName, args) => executeTool(toolName, args, res, req, 'mcp'),
          });
          if (response !== null) responses.push(response);
        }

        // 全是通知 → MCP 规范要求 202 Accepted 且无正文。
        if (responses.length === 0) {
          res.writeHead(202, { 'cache-control': 'no-store' });
          res.end();
          return;
        }

        sendJson(res, 200, isBatch ? responses : responses[0]);
        return;
      }

      // MCP 客户端有时会先发 GET 探测（服务端推送流的通道）。本实现不提供推送。
      if (tail === '/mcp' && req.method === 'GET') {
        sendJson(res, 405, errorEnvelope(ERROR_CODE.BAD_REQUEST, 'this MCP endpoint does not provide a server push stream; use POST'));
        return;
      }

      sendJson(res, 404, errorEnvelope(ERROR_CODE.NOT_FOUND, `no such bridge endpoint: ${url.pathname}`));
  };

  /** 主入口（webServer 回环）的处理器。 */
  const bridgeHandler = makeBridgeHandler(authorize);

  disposers.push(ctx.webServer.register({
    kind: /** @type {const} */ ('prefix'),
    path: basePath,
    handler: bridgeHandler,
  }));

  ctx.logger?.info?.(`dsh-mobile-bridge: mounted at ${basePath} (node=${selfNodeId}, auth=${token !== null ? 'token' : 'none'})`);

  // ------------------------------------------------------- 局域网独立监听
  //
  // DSH 的 webServer 只绑 127.0.0.1，手机在局域网里够不到。
  // 这里另起一个独立监听，只服务桥的端点（复用同一个 handler）。
  //
  // 注意：它是**可选**的，且配置不合法时只记日志、不阻断插件启动 ——
  // 因为主通道（回环）本身是可用的，不该因为局域网配置写错就整个废掉。
  // 每个地址独立启动；某个失败不影响其它。
  // 因为主通道（回环）本身是可用的，不该因为某条局域网配置写错就整个废掉。
  for (const oneLan of lanConfigs) {
    const verdict = validateLanOptions(oneLan);
    if (!verdict.ok) {
      ctx.logger?.warn?.(`dsh-mobile-bridge: LAN listener skipped — ${verdict.reason}`);
      continue;
    }
    // 独立监听用**它自己的** token（不与主 token 混用），
    // 这样即使主 token 泄露，局域网入口仍是独立凭据。
    // handler 与主入口共用同一份实现，只是换一套鉴权。
    const lanHandler = makeBridgeHandler(makeAuthorizer(verdict.token));
    startLanListener({
      host: verdict.host,
      port: verdict.port,
      handler: lanHandler,
      log: (message) => ctx.logger?.info?.(message),
    }).then((started) => {
      if (!started.ok) {
        ctx.logger?.warn?.(`dsh-mobile-bridge: LAN listener failed on ${verdict.host}:${verdict.port} — ${started.reason}`);
        return;
      }
      lanListeners.push(started);
    }).catch((err) => {
      ctx.logger?.warn?.(`dsh-mobile-bridge: LAN listener threw on ${verdict.host}:${verdict.port} — ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // 统一回收：端点 + 所有局域网监听 + 所有入方向注册的工具。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      toolOwners.clear();
      remoteNodes.clear();
      for (const listener of lanListeners.splice(0)) {
        listener.close().catch(() => { /* 关闭失败不阻断卸载 */ });
      }
      for (const dispose of registeredDisposers.splice(0)) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          /* 卸载失败不阻断其它清理 */
        }
      }
      for (const dispose of disposers.splice(0)) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          /* 同上 */
        }
      }
    }, 'dsh-mobile-bridge: teardown');
  }
}
