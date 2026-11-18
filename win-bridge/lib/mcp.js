/**
 * 最小 MCP 服务端（Streamable HTTP 子集）。
 *
 * **为什么需要这个模块**：RikkaHub 的 `McpManager` 已完整实现 MCP 客户端
 * （`McpSessionRegistry.kt:466-478` 支持 `SseClientTransport` 与
 * `StreamableHttpClientTransport`）。只要桥这边讲 MCP，手机侧就能
 * **一行配置、零代码**接入工具 —— 这比让手机实现我们的私有协议省得多。
 *
 * 实现范围（刻意最小，够用即止）：
 *  - `initialize`            握手
 *  - `notifications/initialized`  客户端确认（无响应）
 *  - `tools/list`            列出工具
 *  - `tools/call`            执行工具
 *  - `ping`                  保活
 *
 * 不实现：resources、prompts、sampling、roots、progress、SSE 推送流。
 * 对端请求这些会收到 JSON-RPC 的 `-32601 Method not found`。
 *
 * 传输：POST 单次请求即返回完整 JSON（`application/json`），
 * 不使用 SSE 流式响应。Streamable HTTP 客户端接受这种非流式应答。
 *
 * 纯逻辑，不依赖 DSH 宿主，可脱宿主测试。
 *
 * @module dsh-mobile-bridge/mcp
 */

/** 本实现支持的 MCP 协议版本（取一个广泛支持的稳定版）。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** JSON-RPC 标准错误码。 */
export const RPC_ERROR = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/**
 * 构造一个 JSON-RPC 成功响应。
 *
 * @param {string | number | null} id - 请求 id。
 * @param {unknown} result - 结果。
 * @returns {object}
 */
export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result: result ?? {} };
}

/**
 * 构造一个 JSON-RPC 错误响应。
 *
 * @param {string | number | null} id - 请求 id。
 * @param {number} code - 错误码。
 * @param {string} message - 错误消息。
 * @param {unknown} [data] - 附加数据。
 * @returns {object}
 */
export function rpcError(id, code, message, data) {
  /** @type {{code: number, message: string, data?: unknown}} */
  const error = { code, message: String(message) };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/**
 * 把 DSH 的工具描述（`{name, description, parameters}`）转成 MCP 的 tool 形状。
 *
 * MCP 要求 `inputSchema` 是对象根 JSON Schema。
 *
 * @param {{name: string, description?: string, parameters?: unknown}} wireTool - 桥内部的工具描述。
 * @returns {{name: string, description: string, inputSchema: object}}
 */
export function toMcpTool(wireTool) {
  const parameters = wireTool?.parameters;
  const isObjectSchema = parameters !== null
    && typeof parameters === 'object'
    && /** @type {any} */ (parameters).type === 'object';
  return {
    name: String(wireTool?.name ?? ''),
    description: typeof wireTool?.description === 'string' ? wireTool.description : '',
    inputSchema: isObjectSchema ? parameters : { type: 'object', properties: {} },
  };
}

/**
 * 解析 MCP 的 `tools/call` 参数。
 *
 * @param {unknown} params - JSON-RPC 的 params。
 * @returns {{ok: true, name: string, args: Record<string, unknown>} | {ok: false, reason: string}}
 */
export function parseToolCallParams(params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, reason: 'params must be an object' };
  }
  const name = /** @type {any} */ (params).name;
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, reason: 'params.name is required' };
  }
  const rawArgs = /** @type {any} */ (params).arguments;
  if (rawArgs !== undefined && rawArgs !== null) {
    if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      return { ok: false, reason: 'params.arguments must be an object when present' };
    }
  }
  return { ok: true, name: name.trim(), args: rawArgs ?? {} };
}

/**
 * 把一个工具执行结果投影成 MCP 的 `CallToolResult`。
 *
 * MCP 规定结果形如 `{ content: [{type:'text', text}], isError? }`。
 *
 * @param {{ok: boolean, value?: unknown, content?: unknown[], error?: {code?: string, message?: string}}} outcome - 桥的执行结果。
 * @returns {{content: Array<{type: string, text: string}>, isError?: boolean}}
 */
export function toMcpCallResult(outcome) {
  /** @type {Array<{type: string, text: string}>} */
  const content = [];

  if (outcome?.ok === true) {
    // 优先把 DSH 的 ContentBlock 里的 text 块原样搬过来。
    if (Array.isArray(outcome.content)) {
      for (const block of outcome.content) {
        if (block !== null && typeof block === 'object' && /** @type {any} */ (block).type === 'text'
          && typeof /** @type {any} */ (block).text === 'string') {
          content.push({ type: 'text', text: /** @type {any} */ (block).text });
        }
      }
    }
    // 没有 text 块时，用规范值兜底，避免"成功但内容为空"。
    if (content.length === 0) {
      const value = outcome.value;
      content.push({
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2),
      });
    }
    return { content };
  }

  const error = outcome?.error ?? {};
  const message = typeof error.message === 'string' && error.message !== ''
    ? error.message
    : 'tool execution failed';
  const code = typeof error.code === 'string' && error.code !== '' ? `${error.code}: ` : '';
  return {
    content: [{ type: 'text', text: `${code}${message}` }],
    isError: true,
  };
}

/**
 * 处理一条 JSON-RPC 消息，返回响应（或 null 表示无需响应）。
 *
 * 这个函数是 SDK 无关的纯函数：给它一条消息和一个"执行回调"，
 * 它返回该回什么。所有传输细节（HTTP 状态码、header）由调用方决定。
 *
 * @param {unknown} message - 已解析的 JSON-RPC 消息。
 * @param {object} handlers - 业务回调。
 * @param {() => object[]} handlers.listTools - 返回 wire 工具数组。
 * @param {(name: string, args: object) => Promise<object>} handlers.callTool - 执行工具，返回桥格式结果。
 * @returns {Promise<object | null>} JSON-RPC 响应，或 null（通知不需要响应）。
 */
export async function handleMessage(message, handlers) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, RPC_ERROR.INVALID_REQUEST, 'request must be a JSON-RPC object');
  }
  const msg = /** @type {any} */ (message);

  if (msg.jsonrpc !== '2.0') {
    return rpcError(msg.id ?? null, RPC_ERROR.INVALID_REQUEST, 'jsonrpc must be "2.0"');
  }
  const method = msg.method;
  if (typeof method !== 'string' || method === '') {
    return rpcError(msg.id ?? null, RPC_ERROR.INVALID_REQUEST, 'missing method');
  }

  // 通知（无 id）一律不响应。MCP 里 notifications/initialized 走这条路。
  const isNotification = msg.id === undefined || msg.id === null;

  switch (method) {
    case 'initialize': {
      return rpcResult(msg.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-mobile-bridge', version: '0.1.0' },
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return rpcResult(msg.id, {});

    case 'tools/list': {
      if (isNotification) return null;
      const tools = handlers.listTools().map(toMcpTool);
      return rpcResult(msg.id, { tools });
    }

    case 'tools/call': {
      if (isNotification) return null;
      const parsed = parseToolCallParams(msg.params);
      if (!parsed.ok) {
        return rpcError(msg.id, RPC_ERROR.INVALID_PARAMS, parsed.reason);
      }
      try {
        const outcome = await handlers.callTool(parsed.name, parsed.args);
        return rpcResult(msg.id, toMcpCallResult(outcome));
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        // 工具内部炸了要作为 isError 结果返回，而不是把整个 JSON-RPC 打成错误 ——
        // 否则客户端会以为是协议故障而不是工具失败。
        return rpcResult(msg.id, {
          content: [{ type: 'text', text: messageText }],
          isError: true,
        });
      }
    }

    default:
      return isNotification
        ? null
        : rpcError(msg.id, RPC_ERROR.METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}
