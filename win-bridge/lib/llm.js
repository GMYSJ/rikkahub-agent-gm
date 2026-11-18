/**
 * DSH StreamChunk → OpenAI Chat Completions SSE 转换。
 *
 * **背景**：主提示词要求"电脑模型给手机用"。手机 RikkaHub 已有完整的
 * OpenAI Provider，所以桥只要讲 OpenAI 的 `/v1/chat/completions`，
 * 手机侧**零代码**就能用上电脑的 WorkBuddy 等模型。
 *
 * DSH 侧的真实分片类型（`dsh-llm/src/types.ts:496-508`）：
 *   block-start / text-delta / reasoning-delta / tool-call-delta /
 *   block-end / usage / finish
 *
 * OpenAI SSE 格式：
 *   data: {"id":..,"object":"chat.completion.chunk","choices":[{"index":0,
 *          "delta":{"content":"..."},"finish_reason":null}]}\n\n
 *   ...
 *   data: [DONE]\n\n
 *
 * 纯逻辑，不依赖 DSH 宿主，可脱宿主测试。
 *
 * @module dsh-mobile-bridge/llm
 */

/** 生成响应 id 前缀，避免与 OpenAI 的 chatcmpl- 混淆。 */
export const CHUNK_ID_PREFIX = 'dshbridge';

/**
 * 生成响应 id。
 *
 * @returns {string}
 */
export function newCompletionId() {
  const rand = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `${CHUNK_ID_PREFIX}-${rand}`;
}

/**
 * 构造一个 OpenAI SSE data 帧。
 *
 * @param {object} options - 帧参数。
 * @param {string} options.id - completion id。
 * @param {string} options.model - 模型名。
 * @param {object} options.delta - choices[0].delta 的内容。
 * @param {string | null} [options.finishReason] - 结束原因。
 * @param {object} [options.usage] - usage（仅最后一帧）。
 * @returns {string} SSE 文本，以 \n\n 结尾。
 */
export function sseFrame({ id, model, delta, finishReason = null, usage }) {
  /** @type {object} */
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage !== undefined) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** `[DONE]` 终止帧。 */
export const SSE_DONE = 'data: [DONE]\n\n';

/**
 * 把一个 DSH StreamChunk 转成 0~N 个 OpenAI SSE 帧。
 *
 * 映射表：
 * | DSH | OpenAI delta |
 * |---|---|
 * | block-start(text) | role: assistant（首帧；OpenAI 要求先给 role） |
 * | text-delta | content: text |
 * | reasoning-delta | content: ""（思考内容对用户隐藏；OpenAI 无标准字段） |
 * | tool-call-delta | tool_calls 增量 |
 * | block-end | 无（内容已经在 delta 里发过了） |
 * | usage | 无（合并到 finish 帧） |
 * | finish | finish_reason + usage |
 *
 * 关于 reasoning-delta：OpenAI 没有标准的"思考过程"字段。
 * 有些兼容实现用 `reasoning_content`，但那不是标准；发标准 content 更安全，
 * 否则严格客户端会报错。这里选择**只发一个空 content 帧**，相当于忽略思考文本
 * —— 这是有意的保守选择，宁可不显示思考，也不能让流破裂。
 *
 * @param {object} chunk - DSH StreamChunk。
 * @param {object} ctx - 转换上下文。
 * @param {string} ctx.id - completion id。
 * @param {string} ctx.model - 模型名。
 * @param {boolean} ctx.roleSent - 是否已发过 role 帧。
 * @param {object} [ctx.pendingUsage] - 暂存的 usage。
 * @returns {{frames: string[], roleSent: boolean, pendingUsage: object | undefined, finishReason: string | null}}
 */
export function chunkToSse(chunk, ctx) {
  /** @type {string[]} */
  const frames = [];
  let roleSent = ctx.roleSent;
  let pendingUsage = ctx.pendingUsage;
  let finishReason = null;

  const type = chunk?.type;

  if (type === 'block-start') {
    if (!roleSent) {
      frames.push(sseFrame({ id: ctx.id, model: ctx.model, delta: { role: 'assistant', content: '' } }));
      roleSent = true;
    }
  } else if (type === 'text-delta' || type === 'reasoning-delta') {
    if (!roleSent) {
      frames.push(sseFrame({ id: ctx.id, model: ctx.model, delta: { role: 'assistant', content: '' } }));
      roleSent = true;
    }
    // reasoning 不输出文本，但发一个空 content 帧保持流活性。
    const text = type === 'text-delta' ? (chunk.text ?? '') : '';
    frames.push(sseFrame({ id: ctx.id, model: ctx.model, delta: { content: text } }));
  } else if (type === 'tool-call-delta') {
    if (!roleSent) {
      frames.push(sseFrame({ id: ctx.id, model: ctx.model, delta: { role: 'assistant', content: '' } }));
      roleSent = true;
    }
    /** @type {object} */
    const toolCall = { index: chunk.index ?? 0 };
    if (chunk.id !== undefined) toolCall.id = chunk.id;
    if (chunk.name !== undefined) {
      toolCall.type = 'function';
      toolCall.function = { name: chunk.name, arguments: chunk.argumentsDelta ?? '' };
    } else if (chunk.argumentsDelta !== undefined) {
      toolCall.function = { arguments: chunk.argumentsDelta };
    }
    frames.push(sseFrame({ id: ctx.id, model: ctx.model, delta: { tool_calls: [toolCall] } }));
  } else if (type === 'usage') {
    pendingUsage = normalizeUsage(chunk.usage);
  } else if (type === 'finish') {
    finishReason = mapFinishReason(chunk.reason);
    frames.push(sseFrame({
      id: ctx.id,
      model: ctx.model,
      delta: {},
      finishReason,
      ...(pendingUsage !== undefined ? { usage: pendingUsage } : {}),
    }));
  }
  // block-end 无对应帧：内容已通过 delta 发过。

  return { frames, roleSent, pendingUsage, finishReason };
}

/**
 * DSH FinishReason → OpenAI finish_reason。
 *
 * OpenAI 标准值：stop / length / tool_calls / content_filter / function_call
 *
 * @param {unknown} reason - DSH 的 finish reason。
 * @returns {string} OpenAI finish_reason。
 */
export function mapFinishReason(reason) {
  if (reason === null || reason === undefined) return 'stop';
  const raw = String(reason);
  // DSH 常见值：stop / complete / length / max_tokens / tool_calls / cancelled / error
  if (raw === 'tool_calls' || raw === 'tool-call' || raw === 'tool_use') return 'tool_calls';
  if (raw === 'length' || raw === 'max_tokens' || raw === 'maxTokens') return 'length';
  if (raw === 'content_filter' || raw === 'filtered') return 'content_filter';
  // cancelled / error / aborted 等异常结束一律映射为 stop（OpenAI 无对应值），
  // 但错误信息会通过 HTTP 错误或 isError 结果另行表达。
  return 'stop';
}

/**
 * DSH TokenUsage → OpenAI usage 对象。
 *
 * @param {unknown} usage - DSH usage。
 * @returns {object | undefined}
 */
export function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined;
  const u = /** @type {any} */ (usage);
  const prompt = u.inputTokens ?? u.promptTokens ?? u.prompt ?? 0;
  const completion = u.outputTokens ?? u.completionTokens ?? u.completion ?? 0;
  return {
    prompt_tokens: typeof prompt === 'number' ? prompt : 0,
    completion_tokens: typeof completion === 'number' ? completion : 0,
    total_tokens: (typeof prompt === 'number' ? prompt : 0) + (typeof completion === 'number' ? completion : 0),
  };
}

/**
 * 把 OpenAI chat/completions 请求体转成 DSH `GenerateOptions`。
 *
 * 支持的字段：model / messages / temperature / max_tokens / tools / stream / signal。
 * 不支持的字段（top_p、presence_penalty 等）静默忽略 —— 宁可少传，
 * 也不要因为一个不认识的字段让整个请求失败。
 *
 * @param {unknown} body - OpenAI 请求体。
 * @returns {{ok: true, options: object} | {ok: false, reason: string}}
 */
export function openAiRequestToGenerateOptions(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'request body must be an object' };
  }
  const raw = /** @type {any} */ (body);
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (model === '') return { ok: false, reason: '`model` is required' };
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    return { ok: false, reason: '`messages` must be a non-empty array' };
  }

  /** @type {Array<object>} */
  const messages = [];
  for (const m of raw.messages) {
    if (m === null || typeof m !== 'object') {
      return { ok: false, reason: 'each message must be an object' };
    }
    const role = String(m.role ?? '');
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) {
      return { ok: false, reason: `unsupported message role: ${role}` };
    }
    // DSH 的 RequestUserInput 只接受 content 文本；图片/文件输入 v1 不支持，
    // 这里把非字符串 content 降级成 JSON 文本，而不是丢弃整条消息。
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content ?? '');
    /** @type {object} */
    const out = { role, content };
    if (role === 'tool' && typeof m.tool_call_id === 'string') out.toolCallId = m.tool_call_id;
    messages.push(out);
  }

  /** @type {object} */
  const options = { model, messages };
  // DSH 的 GenerateOptions 需要 { provider, model } 两个字段：
  //   provider = 已注册的路由键（如 workbuddy / deepseek-official）
  //   model    = 该路由下的真实模型 id
  // RikkaHub 习惯传 "provider/model" 形式的字符串，这里拆开；
  // 若没有斜杠，则 provider 与 model 用同一个值（调用方需自行保证正确）。
  const slash = model.indexOf('/');
  if (slash > 0 && slash < model.length - 1) {
    options.provider = model.slice(0, slash);
    options.model = model.slice(slash + 1);
  } else {
    options.provider = model;
    options.model = model;
  }
  if (typeof raw.temperature === 'number') options.temperature = raw.temperature;
  if (typeof raw.max_tokens === 'number') options.maxTokens = raw.max_tokens;
  if (Array.isArray(raw.tools) && raw.tools.length > 0) {
    /** @type {Array<object>} */
    const tools = [];
    for (const t of raw.tools) {
      const fn = t?.function;
      if (fn === null || typeof fn !== 'object') continue;
      tools.push({
        name: String(fn.name ?? ''),
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters: fn.parameters !== undefined && fn.parameters !== null ? fn.parameters : {},
      });
    }
    if (tools.length > 0) options.tools = tools;
  }

  return { ok: true, options };
}
