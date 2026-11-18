/**
 * DSH <-> 远端节点 桥接协议（v1）
 *
 * 纯逻辑，不 import 任何宿主包，因此可以脱离 DSH 单独跑测试。
 *
 * 设计约束（来自实测，见 project-docs/PROTOCOL_SPEC.md）：
 *  1. DSH 侧没有 MCP Server 能力（运行时未打包 @modelcontextprotocol/server），
 *     所以不复用 MCP，改用一个极小的、可版本化的 HTTP JSON 协议。
 *  2. 所有跨端请求必须可追踪、可去重、可取消，并防止工具循环调用 —— 由 trace 头承载。
 *  3. 协议不绑定具体网络形态：局域网直连、内网穿透、反向隧道都只是 baseUrl 不同。
 *
 * @module dsh-mobile-bridge/protocol
 */

/** 协议版本。任何不兼容改动都必须递增，并由两端做显式协商。 */
export const PROTOCOL_VERSION = 1;

/** 单次请求允许的最大跨端跳数。达到后一律拒绝，用于阻断 A→B→A 循环。 */
export const MAX_HOP_COUNT = 2;

/** 协议错误码。响应体 `error.code` 取自这里。 */
export const ERROR_CODE = Object.freeze({
  BAD_REQUEST: 'bad_request',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  TOOL_NOT_FOUND: 'tool_not_found',
  TOOL_FAILED: 'tool_failed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  HOP_LIMIT: 'hop_limit',
  VERSION_MISMATCH: 'version_mismatch',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  INTERNAL: 'internal',
});

/** 系统保留的 trace 头名，两端必须一致。 */
export const HEADER = Object.freeze({
  TRACE_ID: 'x-dsh-trace-id',
  HOP_COUNT: 'x-dsh-hop-count',
  SOURCE_NODE: 'x-dsh-source-node',
  TARGET_NODE: 'x-dsh-target-node',
  REQUEST_ID: 'x-dsh-request-id',
  PROTOCOL: 'x-dsh-protocol',
  AUTHORIZATION: 'authorization',
});

/**
 * 从一个 HTTP header 字典里解析跨端追踪上下文。
 *
 * 缺失或非法的字段一律降级为默认值，而不是抛错 —— 追踪元数据不该
 * 成为拒绝一个本该成功的工具调用的理由。唯一例外是跳数超限，那属于
 * 安全边界，必须拒绝。
 *
 * @param {Record<string, string | string[] | undefined>} headers - Node 的原始 header 字典（键名大小写不定）。
 * @returns {{traceId: string, hopCount: number, sourceNode: string | null, targetNode: string | null, requestId: string | null, protocol: number}}
 */
export function parseTrace(headers) {
  const get = (name) => {
    if (headers === null || typeof headers !== 'object') return undefined;
    const direct = headers[name];
    if (direct !== undefined) return Array.isArray(direct) ? direct[0] : direct;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) {
        const value = headers[key];
        return Array.isArray(value) ? value[0] : value;
      }
    }
    return undefined;
  };

  const asString = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };

  const rawHops = asString(get(HEADER.HOP_COUNT));
  const parsedHops = rawHops === null ? NaN : Number.parseInt(rawHops, 10);
  const hopCount = Number.isFinite(parsedHops) && parsedHops >= 0 ? parsedHops : 0;

  const rawProtocol = asString(get(HEADER.PROTOCOL));
  const parsedProtocol = rawProtocol === null ? NaN : Number.parseInt(rawProtocol, 10);

  return {
    traceId: asString(get(HEADER.TRACE_ID)) ?? 'untraced',
    hopCount,
    sourceNode: asString(get(HEADER.SOURCE_NODE)),
    targetNode: asString(get(HEADER.TARGET_NODE)),
    requestId: asString(get(HEADER.REQUEST_ID)),
    protocol: Number.isFinite(parsedProtocol) ? parsedProtocol : PROTOCOL_VERSION,
  };
}

/**
 * 判断一次入站请求是否必须因循坏风险被拒绝。
 *
 * @param {{hopCount: number}} trace - {@link parseTrace} 的结果。
 * @returns {{ok: true} | {ok: false, reason: string, code: string}}
 */
export function checkHopBudget(trace) {
  const hopCount = trace !== null && typeof trace === 'object' ? trace.hopCount : 0;
  if (!Number.isFinite(hopCount) || hopCount < 0) {
    return { ok: false, reason: 'invalid hop count', code: ERROR_CODE.BAD_REQUEST };
  }
  if (hopCount >= MAX_HOP_COUNT) {
    return {
      ok: false,
      reason: `hop count ${hopCount} reached the limit of ${MAX_HOP_COUNT}; refusing to forward again to avoid a tool-call loop`,
      code: ERROR_CODE.HOP_LIMIT,
    };
  }
  return { ok: true };
}

/**
 * 构造下一次向外转发时要带的 header。
 *
 * 每次跨端调用跳数 +1，`sourceNode` 换成自己，`targetNode` 换成对端。
 * 这样对端看到的永远是「谁在调我」，而不是最初那个节点。
 *
 * @param {object} options - 出站参数。
 * @param {{traceId: string, hopCount: number}} options.trace - 入站追踪上下文。
 * @param {string} options.selfNodeId - 本节点标识。
 * @param {string} options.targetNodeId - 目标节点标识。
 * @param {string} [options.requestId] - 请求 id，缺省由调用方生成。
 * @param {string} [options.authorization] - 鉴权 header 值，如 `Bearer xxx`。
 * @returns {Record<string, string>}
 */
export function buildOutboundHeaders({ trace, selfNodeId, targetNodeId, requestId, authorization }) {
  const hopCount = (trace?.hopCount ?? 0) + 1;
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': 'application/json',
    [HEADER.PROTOCOL]: String(PROTOCOL_VERSION),
    [HEADER.HOP_COUNT]: String(hopCount),
    [HEADER.SOURCE_NODE]: String(selfNodeId),
    [HEADER.TARGET_NODE]: String(targetNodeId),
  };
  if (trace?.traceId) headers[HEADER.TRACE_ID] = String(trace.traceId);
  if (requestId) headers[HEADER.REQUEST_ID] = String(requestId);
  if (authorization) headers[HEADER.AUTHORIZATION] = String(authorization);
  return headers;
}

/**
 * 生成一个 trace id。没有随机源可用时退化，保证永远返回非空字符串。
 *
 * @returns {string}
 */
export function newTraceId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    /* 退化到下面的 fallback */
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 构造成功响应体。
 *
 * @param {unknown} result - 工具返回值（必须是 JSON 可序列化）。
 * @returns {{ok: true, result: unknown}}
 */
export function okEnvelope(result) {
  return { ok: true, result: result ?? null };
}

/**
 * 构造失败响应体。
 *
 * @param {string} code - {@link ERROR_CODE} 中的值。
 * @param {string} message - 面向调用方的错误说明。
 * @param {Record<string, unknown>} [details] - 可选结构化细节。
 * @returns {{ok: false, error: {code: string, message: string, details?: Record<string, unknown>}}}
 */
export function errorEnvelope(code, message, details) {
  /** @type {{code: string, message: string, details?: Record<string, unknown>}} */
  const error = { code: String(code), message: String(message) };
  if (details !== undefined && details !== null) error.details = details;
  return { ok: false, error };
}

/**
 * 校验一个在 wire 上收到的工具描述是否结构完整。
 *
 * 这里只做结构校验，不做 JSON Schema 的语义校验 —— 参数 schema 由
 * 提供方（对端）负责，DSH 侧只按原样转交给模型。
 *
 * @param {unknown} value - 待校验的 wire 工具描述。
 * @returns {{ok: true, tool: {name: string, description: string, parameters: object|null}} | {ok: false, reason: string}}
 */
export function validateWireTool(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'tool descriptor must be a JSON object' };
  }
  const name = value.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, reason: 'tool descriptor requires a non-empty string `name`' };
  }
  if (name.length > 128) {
    return { ok: false, reason: `tool name is too long (${name.length} > 128)` };
  }
  const description = typeof value.description === 'string' ? value.description : '';
  const rawParameters = value.parameters;
  if (rawParameters !== undefined && rawParameters !== null) {
    if (typeof rawParameters !== 'object' || Array.isArray(rawParameters)) {
      return { ok: false, reason: 'tool `parameters` must be a JSON Schema object when present' };
    }
  }
  return {
    ok: true,
    tool: {
      name: name.trim(),
      description,
      parameters: rawParameters ?? null,
    },
  };
}

/**
 * 把对端工具名转成本地对外暴露的名字。
 *
 * 前缀是安全边界的一部分：RikkaHub 的审批体系对 `mcp__` 前缀的工具
 * 默认要求人工批准，这里沿用同一约定，任何远端工具都不会悄悄变成
 * 免审批工具。
 *
 * @param {string} nodeSlug - 节点短标识，须匹配 [A-Za-z0-9_]，调用方负责清洗。
 * @param {string} toolName - 对端给的原始工具名。
 * @returns {string} 形如 `mcp__<nodeSlug>__<toolName>`。
 */
export function qualifyToolName(nodeSlug, toolName) {
  const slug = String(nodeSlug).replace(/[^A-Za-z0-9_]/g, '_');
  const local = String(toolName).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `mcp__${slug}__${local}`;
}

/**
 * 反向操作：从本地暴露名解析回 (节点, 原始工具名)。
 *
 * @param {string} qualified - {@link qualifyToolName} 产出的名字。
 * @returns {{nodeSlug: string, toolName: string} | null} 不符合约定时返回 null。
 */
export function parseQualifiedToolName(qualified) {
  if (typeof qualified !== 'string') return null;
  const match = /^mcp__([A-Za-z0-9_]+)__(.+)$/.exec(qualified);
  if (match === null) return null;
  return { nodeSlug: match[1], toolName: match[2] };
}
