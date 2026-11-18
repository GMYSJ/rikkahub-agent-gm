/**
 * 远端节点 HTTP 客户端（脱宿主可测）。
 *
 * 桥的「出」方向由 DSH 提供端点、手机来调；「入」方向反过来 ——
 * 手机提供同样的端点，DSH 作为客户端去调。这个模块只负责后一半，
 * 不 import 任何 DSH 包，因此可以用一个假的 fetch 完整测试。
 *
 * @module dsh-mobile-bridge/client
 */

import {
  PROTOCOL_VERSION,
  ERROR_CODE,
  HEADER,
  newTraceId,
  buildOutboundHeaders,
  validateWireTool,
} from './protocol.js';

/** 单次远端调用默认超时。 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 调用一个远端节点上的工具。
 *
 * 设计要点：
 *  - 复用桥协议（`POST <baseUrl>/tools/call`），因此两端实现必然对称；
 *  - 出站一律带 trace 头并让跳数 +1，保证循环调用能被对端拒绝；
 *  - 超时与取消都通过 `AbortSignal` 贯穿，不留下悬挂连接。
 *
 * @param {object} options - 调用参数。
 * @param {string} options.baseUrl - 远端节点桥的根地址，如 `https://192.168.1.3:8443/phone-bridge`。
 * @param {string} options.selfNodeId - 本节点标识，写进 trace 头。
 * @param {string} options.targetNodeId - 目标节点标识。
 * @param {string} options.tool - 远端原始工具名（不是 `mcp__x__y` 形式）。
 * @param {unknown} [options.args] - 工具参数。
 * @param {{traceId: string, hopCount: number}} [options.trace] - 上游追踪上下文。
 * @param {string} [options.token] - 共享令牌。
 * @param {AbortSignal} [options.signal] - 上游取消信号。
 * @param {number} [options.timeoutMs] - 超时。
 * @param {typeof fetch} [options.fetchImpl] - 注入点，便于测试。
 * @returns {Promise<{ok: true, value: unknown, content: unknown[]} | {ok: false, code: string, message: string, content: unknown[]}>}
 */
export async function callRemoteTool(options) {
  const {
    baseUrl,
    selfNodeId,
    targetNodeId,
    tool,
    args,
    trace,
    token,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = options;

  if (typeof fetchImpl !== 'function') {
    return { ok: false, code: ERROR_CODE.INTERNAL, message: 'no fetch implementation available', content: [] };
  }

  const traceContext = trace ?? { traceId: newTraceId(), hopCount: 0 };
  const headers = buildOutboundHeaders({
    trace: traceContext,
    selfNodeId,
    targetNodeId,
    requestId: newTraceId(),
    authorization: token === null || token === undefined ? undefined : `Bearer ${token}`,
  });

  // 合并上游取消与本地超时：任一触发都要中止这次请求。
  const controller = new AbortController();
  const onUpstreamAbort = () => controller.abort(signal?.reason ?? new Error('cancelled by caller'));
  if (signal !== undefined) {
    if (signal.aborted) onUpstreamAbort();
    else signal.addEventListener('abort', onUpstreamAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error('remote tool timeout')), timeoutMs);

  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/tools/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tool, arguments: args ?? {} }),
      signal: controller.signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (payload === null || typeof payload !== 'object') {
      return {
        ok: false,
        code: ERROR_CODE.INTERNAL,
        message: `remote node returned a non-JSON response (status ${response.status})`,
        content: [],
      };
    }

    if (payload.ok === true) {
      return {
        ok: true,
        value: payload.result ?? null,
        content: Array.isArray(payload.content) ? payload.content : [],
      };
    }

    const error = payload.error ?? {};
    return {
      ok: false,
      code: typeof error.code === 'string' && error.code !== '' ? error.code : ERROR_CODE.TOOL_FAILED,
      message: typeof error.message === 'string' && error.message !== ''
        ? error.message
        : `remote node returned status ${response.status}`,
      content: Array.isArray(payload.content) ? payload.content : [],
    };
  } catch (err) {
    const aborted = controller.signal.aborted;
    const reason = aborted ? controller.signal.reason : err;
    const message = reason instanceof Error ? reason.message : String(reason);
    const timedOut = aborted && !(signal?.aborted === true);
    return {
      ok: false,
      code: timedOut ? ERROR_CODE.TIMEOUT : aborted ? ERROR_CODE.CANCELLED : ERROR_CODE.TOOL_FAILED,
      message,
      content: [],
    };
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener('abort', onUpstreamAbort);
  }
}

/**
 * 从远端节点拉取工具清单。
 *
 * 返回的是**已通过结构校验**的工具，非法的单独记进 `rejected`，
 * 这样对端一个坏工具不会让整个节点不可用。
 *
 * @param {object} options - 拉取参数。
 * @param {string} options.baseUrl - 远端桥根地址。
 * @param {string} [options.token] - 共享令牌。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @param {number} [options.timeoutMs] - 超时。
 * @param {typeof fetch} [options.fetchImpl] - 注入点。
 * @returns {Promise<{ok: true, nodeId: string | null, tools: object[], rejected: object[]} | {ok: false, code: string, message: string}>}
 */
export async function fetchRemoteTools(options) {
  const {
    baseUrl,
    token,
    signal,
    timeoutMs = 30_000,
    fetchImpl = globalThis.fetch,
  } = options;

  if (typeof fetchImpl !== 'function') {
    return { ok: false, code: ERROR_CODE.INTERNAL, message: 'no fetch implementation available' };
  }

  /** @type {Record<string, string>} */
  const headers = { [HEADER.PROTOCOL]: String(PROTOCOL_VERSION) };
  if (token !== null && token !== undefined) headers[HEADER.AUTHORIZATION] = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('list tools timeout')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('cancelled'));
  if (signal !== undefined) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/tools`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
      const err = payload?.error ?? {};
      return {
        ok: false,
        code: typeof err.code === 'string' ? err.code : ERROR_CODE.INTERNAL,
        message: typeof err.message === 'string' ? err.message : `status ${response.status}`,
      };
    }

    const rawTools = Array.isArray(payload.result?.tools) ? payload.result.tools : [];
    const tools = [];
    const rejected = [];
    for (const raw of rawTools) {
      const verdict = validateWireTool(raw);
      if (verdict.ok) tools.push(verdict.tool);
      else rejected.push({ name: raw?.name ?? null, reason: verdict.reason });
    }
    const nodeId = typeof payload.result?.nodeId === 'string' ? payload.result.nodeId : null;
    return { ok: true, nodeId, tools, rejected };
  } catch (err) {
    const aborted = controller.signal.aborted;
    const reason = aborted ? controller.signal.reason : err;
    return {
      ok: false,
      code: aborted ? ERROR_CODE.TIMEOUT : ERROR_CODE.TOOL_FAILED,
      message: reason instanceof Error ? reason.message : String(reason),
    };
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
