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
 * 单次转发给模型的工具上限。
 *
 * 手机侧会把本地全部工具 + 桥的工具一起发来（实测 174 个），
 * 远超多数模型的处理能力：实测 workbuddy 在 174 个工具时指令跟随崩溃
 * （中文变英文、陷入工具循环），0 工具时正常。
 * 40 是一个保守上限：足够覆盖电脑侧 28 个工具 + 少量手机工具。
 */
export const MAX_FORWARDED_TOOLS = 120;

/**
 * 单条工具结果允许的最大字符数，超出部分截断。
 *
 * 实测：单条工具结果可达 17997 字符；多轮累积 154 条消息共 106764 字符
 * （约 30K tokens）后，模型会退化成英文长篇推理并陷入工具循环。
 * 4000 足够保留结构化结果的关键部分，又不会撑爆上下文。
 */
export const MAX_TOOL_RESULT_CHARS = 4_000;

/**
 * max_tokens 安全下限。
 *
 * 推理模型会先用 token 做思考，客户端给的值太小（如 50）时思考把预算吃光，
 * 正文一个字都出不来 → 手机端表现为「连上了但模型不回复」。
 * 2048 给思考留足空间，且远低于各模型上限，不会触发「超限」错误。
 */
export const MIN_MAX_TOKENS = 2_048;

/** 单条历史 assistant 消息允许的最大字符数（比工具结果宽松，保留上下文语义）。 */
export const MAX_ASSISTANT_CHARS = 8_000;

/**
 * 截断一个 content block 数组里的超长文本块。
 *
 * @param {Array<object>} blocks - 内容块数组。
 * @param {number} maxChars - 单个文本块的最大字符数。
 * @returns {Array<object>} 截断后的数组（不修改入参）。
 */
export function truncateContentBlocks(blocks, maxChars) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((b) => {
    if (b === null || typeof b !== 'object') return b;
    if (b.type !== 'text' || typeof b.text !== 'string') return b;
    if (b.text.length <= maxChars) return b;
    const omitted = b.text.length - maxChars;
    return {
      ...b,
      text: `${b.text.slice(0, maxChars)}\n…[已截断 ${omitted} 字符，原长 ${b.text.length}]`,
    };
  });
}

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
    const text = chunk.text ?? '';
    if (type === 'text-delta') {
      ctx.hasText = true;
      frames.push(sseFrame({ id: ctx.id, model: ctx.model, delta: { content: text } }));
    } else {
      // reasoning-delta 只走 reasoning_content（思考字段），**不进 content**。
      // 之前同时塞 content 会导致每个思考分片都被当成正文显示，
      // 屏幕上出现"一连串的思考了0秒"并把对话切碎。
      // 同时累积到 reasoningBuffer：若整轮都没有 text-delta，
      // 在 finish 时一次性作为 content 兜底（避免空回复）。
      ctx.reasoningBuffer = (ctx.reasoningBuffer || '') + text;
      frames.push(sseFrame({
        id: ctx.id,
        model: ctx.model,
        delta: { reasoning_content: text },
      }));
    }
  } else if (type === 'tool-call-delta') {
    if (!roleSent) {
      frames.push(sseFrame({ id: ctx.id, model: ctx.model, delta: { role: 'assistant', content: '' } }));
      roleSent = true;
    }
    /**
     * 关键：name 只能发一次！
     *
     * pi-ai 适配器（workbuddy 用）的每个 tool-call-delta 分片都带 name，
     * 而 OpenAI 流式解析器会把每个 delta 的 function.name 累加，
     * 导致 "workspace_read_folderworkspace_read_folder..." 重复拼接 → tool_not_found。
     *
     * 用 namedToolIds 跟踪：同一 tool id 的 name 只发第一帧，
     * 后续帧只发 arguments 增量（标准 OpenAI 行为）。
     */
    // 标记本轮有工具调用：这样的轮次不需要"只输出了思考"的提示，
    // 因为对话还没结束，工具结果会驱动下一轮继续生成正文。
    ctx.hasToolCall = true;
    if (ctx.namedToolIds === undefined) ctx.namedToolIds = new Set();
    // key 必须能区分不同工具：优先 id，其次 index。
    // 注意不能用 `chunk.id ?? chunk.index` —— 空字符串 id 会让所有工具
    // 共用一个 key，第二个工具的 name 就永远发不出去（工具名变空）。
    const rawKey = (typeof chunk.id === 'string' && chunk.id !== '')
      ? `id:${chunk.id}`
      : `idx:${chunk.index ?? 0}`;
    const shouldSendName = chunk.name !== undefined && !ctx.namedToolIds.has(rawKey);
    if (shouldSendName) ctx.namedToolIds.add(rawKey);

    /** @type {object} */
    const toolCall = { index: chunk.index ?? 0 };
    if (chunk.id !== undefined) toolCall.id = chunk.id;
    if (shouldSendName) {
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
    // finish reason 可能是 {kind:'error', failure:{message,code}}（DSH 把
    // 模型调用失败如 429 限流也包成 finish 帧）。必须把错误显示出来，
    // 否则用户只看到空回复，完全不知道是限流/密钥失效。
    const errText = extractFinishError(chunk.reason);
    // 若整轮只有思考（reasoning）而完全没有正文：
    // **绝不把思考当正文发出去**——那正是用户看到的「突然爆一大堆英文」，
    // 因为模型的内部推理是英文的。思考内容已通过 reasoning_content 分片
    // 发出，客户端（RikkaHub）有自己的思考区可展示。
    //
    // 但**有工具调用的轮次不插提示**：那是 agent 循环的中间轮，
    // 工具结果会驱动下一轮继续输出正文，此时插提示会打断正常流程
    // （用户实测：提示语出现在工具调用之后、真正回答之前）。
    if (!ctx.hasText && errText === null && ctx.hasToolCall !== true) {
      const hadReasoning = (ctx.reasoningBuffer || '') !== '';
      if (hadReasoning) {
        frames.push(sseFrame({
          id: ctx.id,
          model: ctx.model,
          delta: { content: '（模型只输出了思考过程，没有生成正文。可尝试重新发送或更换模型。）' },
        }));
      }
      ctx.reasoningBuffer = '';
    }
    if (errText !== null) {
      frames.push(sseFrame({ id: ctx.id, model: ctx.model, delta: { content: `[模型错误] ${errText}` } }));
    }
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
 * 从 DSH 的 finish reason 里提取错误文本。
 *
 * reason 可能是字符串（stop/length...），也可能是
 * `{kind:'error', failure:{message, code}}`（模型调用失败，如 429 限流）。
 *
 * @param {unknown} reason - DSH finish reason。
 * @returns {string | null} 错误说明，或 null（正常结束）。
 */
export function extractFinishError(reason) {
  if (reason === null || typeof reason !== 'object') return null;
  const r = /** @type {any} */ (reason);
  if (r.kind !== 'error') return null;
  const failure = r.failure ?? {};
  const message = typeof failure.message === 'string' && failure.message !== ''
    ? failure.message
    : String(r.kind);
  const code = typeof failure.code === 'string' && failure.code !== '' ? `[${failure.code}] ` : '';
  return `${code}${message}`;
}

/**
 * 把 DSH / 上游抛出的技术性错误翻译成用户能看懂的中文说明。
 *
 * 背景：模型有时把工具调用的 JSON 参数吐一半就停下，
 * pi-ai 适配器会抛 `MALFORMED_RESPONSE`（dsh-llm-pi-ai/src/stream.ts:227-228），
 * 原文是 "Expected ':' after property name in JSON at position 9" 这种，
 * 用户完全不知道发生了什么、也不知道该怎么办。
 *
 * @param {string} raw - 原始错误文本。
 * @returns {string} 友好说明（保留原始信息便于排障）。
 */
export function friendlyLlmError(raw) {
  const text = String(raw ?? '');
  if (text === '') return '模型调用失败（无详细信息）';
  if (text.includes('MALFORMED_RESPONSE') || /Expected .* in JSON|Unexpected end of JSON|invalid JSON/i.test(text)) {
    return `模型生成工具参数时被截断或格式不完整，本次调用作废。`
      + `通常重新发送即可；若反复出现，请换模型或把任务拆小。原始信息：${text}`;
  }
  if (text.includes('EMPTY_RESPONSE')) {
    return `模型没有返回任何内容（可能是思考耗尽了 token 预算）。建议提高 max_tokens 或换模型。原始信息：${text}`;
  }
  if (/\b429\b|rate.?limit|quota/i.test(text)) {
    return `模型被限流或额度不足，请稍后重试或换模型。原始信息：${text}`;
  }
  if (/context|token.*(limit|exceed)|too long/i.test(text)) {
    return `对话上下文超出模型上限。建议新建对话或缩短历史。原始信息：${text}`;
  }
  return text;
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
  if (typeof reason === 'object' && (/** @type {any} */ (reason)).kind === 'error') return 'stop';
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
 * 解析 OpenAI image_url 里的图片数据。
 *
 * 支持两种形式：
 *  - data URL：`data:image/png;base64,XXXX`
 *  - 远程 URL：http(s)://...（需要下载，成本高，这里只识别不下载）
 *
 * @param {unknown} rawUrl - image_url.url 的原始值。
 * @returns {{ok: true, data: Uint8Array, mediaType: string} | {ok: false, reason: string}}
 */
export function parseDataUrlImage(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') {
    return { ok: false, reason: 'empty image url' };
  }
  if (!rawUrl.startsWith('data:')) {
    return { ok: false, reason: 'remote image url (not downloaded)' };
  }
  const comma = rawUrl.indexOf(',');
  if (comma < 0) return { ok: false, reason: 'malformed data url' };
  const meta = rawUrl.slice(5, comma);
  if (!meta.includes('base64')) return { ok: false, reason: 'non-base64 data url' };
  const mediaType = meta.split(';')[0] || 'image/png';
  try {
    const b64 = rawUrl.slice(comma + 1);
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) data[i] = bin.charCodeAt(i);
    if (data.length === 0) return { ok: false, reason: 'decoded image is empty' };
    return { ok: true, data, mediaType };
  } catch (e) {
    return { ok: false, reason: `base64 decode failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 把 OpenAI image_url 内容块转成 DSH 的 ImageBlock（真正让模型看图）。
 *
 * DSH 的图片不是内联 base64，而是附件引用：
 *   ImageBlock = { type:'image', attachment: ImageAttachmentRef }
 *   （dsh-llm/src/types.ts:86-89）
 * 附件必须先落地进 attachment store：
 *   ctx.attachments.saveImages([{ data, mediaType, name }]) → ImageAttachmentRef[]
 *   （dsh-acp/src/content.ts:150-166 是现成范例）
 *
 * 若 attachments 服务不可用（profile 没挂附件组件）或图片解析失败，
 * 退回文字占位——宁可让模型知道"这里有图但看不到"，
 * 也不要把整个对话搞崩（旧版就是直接透传导致 413 / 连接中断）。
 *
 * @param {Array<object>} blocks - 原始内容块数组。
 * @param {{saveImages?: Function} | undefined} attachments - DSH 附件服务。
 * @returns {Promise<Array<object>>} 转换后的内容块数组。
 */
export async function convertImageBlocks(blocks, attachments) {
  if (!Array.isArray(blocks)) return blocks;
  const out = [];
  for (const b of blocks) {
    if (b === null || typeof b !== 'object') {
      out.push(b);
      continue;
    }
    const type = String(b.type ?? '');
    if (type !== 'image_url') {
      out.push(b);
      continue;
    }
    const rawUrl = b.image_url?.url ?? b.image_url ?? '';
    const parsed = parseDataUrlImage(rawUrl);
    if (!parsed.ok) {
      const hint = typeof rawUrl === 'string' && rawUrl.startsWith('data:')
        ? `base64 约 ${Math.round(rawUrl.length / 1024)} KB`
        : parsed.reason;
      out.push({ type: 'text', text: `[图片：${hint}；当前通道未能传递图片内容，如需判断请让用户用文字描述]` });
      continue;
    }
    // 有附件服务就真正入库，让模型看到图。
    if (attachments !== undefined && typeof attachments.saveImages === 'function') {
      try {
        const refs = await attachments.saveImages([{
          data: parsed.data,
          mediaType: parsed.mediaType,
          name: 'mobile-upload',
        }]);
        if (Array.isArray(refs) && refs.length === 1 && refs[0] !== undefined) {
          out.push({ type: 'image', attachment: refs[0] });
          continue;
        }
      } catch (_saveFailed) {
        // 落到下面的文字占位
      }
    }
    out.push({
      type: 'text',
      text: `[图片：base64 约 ${Math.round(parsed.data.length / 1024)} KB；当前通道未能传递图片内容，如需判断请让用户用文字描述]`,
    });
  }
  return out;
}

/**
 * 预扫描：把请求体里所有 image_url 块转成 DSH 的 ImageBlock 或文字占位。
 *
 * 因为 `saveImages` 是异步的，而 `openAiRequestToGenerateOptions` 保持同步
 * （测试与既有调用都依赖它同步返回），所以图片处理必须**先**在这步完成：
 * 把每个 image_url 就地替换成 `{type:'image', attachment}` 或文字块，
 * 之后同步转换器只需原样接受这些块即可。
 *
 * @param {unknown} body - OpenAI 请求体（会被就地修改 messages）。
 * @param {{saveImages?: Function, readImageRequest?: Function} | undefined} attachments - DSH 附件服务。
 * @returns {Promise<{saved: number, readable: number, details: string[]}>}
 */
export async function preprocessingImages(body, attachments) {
  const result = { saved: 0, readable: 0, details: [], roles: [], messageIds: [] };
  if (body === null || typeof body !== 'object') return result;
  const messages = /** @type {any} */ (body).messages;
  if (!Array.isArray(messages)) return result;
  for (const [msgIndex, m] of messages.entries()) {
    if (m === null || typeof m !== 'object') continue;
    if (!Array.isArray(m.content)) continue;
    const hasImage = m.content.some((b) => b !== null && typeof b === 'object' && b.type === 'image_url');
    if (!hasImage) continue;
    // 记录图片出现在哪个角色：DSH 的 ImageBlock 文档写明
    // "only user messages may carry images"
    // （dsh-llm/src/types.ts:80-85）。
    // 若图片落在 tool/assistant 消息里，下游极可能被丢弃，
    // 模型就只看到"图片不可用"的文字句柄 —— 即用户说的「空通道」。
    result.roles.push(String(m.role ?? 'unknown'));
    result.messageIds.push(`${msgIndex}:${String(m.role ?? '')}`);
    const converted = await convertImageBlocks(m.content, attachments);
    const imageBlocks = converted.filter((b) => b !== null && typeof b === 'object' && b.type === 'image');
    result.saved += imageBlocks.length;
    // 立刻验证每个 ref 能否读回：这是「模型看得到图」的前提。
    for (const block of imageBlocks) {
      const check = await verifyImageRef(attachments, block.attachment);
      if (check.readable) {
        result.readable += 1;
        result.details.push(`ok:${check.bytes}B`);
      } else {
        result.details.push(`unreadable:${check.reason ?? 'unknown'}`);
      }
    }
    m.content = converted;
  }
  return result;
}

/**
 * 验证已保存的图片引用能否被读回（排障用）。
 *
 * `pi-ai` 适配器在发请求前会用 `attachments.readImageRequest()` 把图片
 * 读成实际字节（dsh-llm-pi-ai/src/context.ts:112-129）。如果这步拿不到数据，
 * 模型就只看到占位文字、看不到像素 —— 用户现象是「收到的截图是空通道」。
 *
 * 这里主动读一次，把结果记进诊断，区分「存进去了」和「读得回来」。
 *
 * @param {{readImageRequest?: Function} | undefined} attachments - 附件服务。
 * @param {object} ref - saveImages 返回的引用。
 * @returns {Promise<{readable: boolean, bytes?: number, reason?: string}>}
 */
export async function verifyImageRef(attachments, ref) {
  if (attachments === undefined || typeof attachments.readImageRequest !== 'function') {
    return { readable: false, reason: 'readImageRequest unavailable' };
  }
  try {
    const version = await attachments.readImageRequest(
      ref,
      { width: 2048, height: 2048, maxBytes: 8 * 1024 * 1024 },
    );
    if (version === undefined || version === null) {
      return { readable: false, reason: 'readImageRequest returned empty' };
    }
    const data = version.data;
    const bytes = data !== undefined && data !== null && typeof data.length === 'number'
      ? data.length : (data instanceof Uint8Array ? data.byteLength : 0);
    if (bytes === 0) return { readable: false, reason: 'zero bytes' };
    return { readable: true, bytes };
  } catch (e) {
    return { readable: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 同步版降级：把**未处理的** OpenAI `image_url` 块换成文字占位。
 *
 * 只处理 `image_url`。已经转换好的 `{type:'image', attachment}` 必须原样保留 ——
 * 那是 preprocessingImages() 成功上传后的成果，再降级就等于把图片扔掉
 * （这曾导致「图片存成功了，模型却只看到空占位」的假象）。
 *
 * @param {Array<object>} blocks - 原始内容块数组。
 * @returns {Array<object>} 降级后的内容块数组。
 */
export function degradeImageBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((b) => {
    if (b === null || typeof b !== 'object') return b;
    const type = String(b.type ?? '');
    if (type !== 'image_url') return b;
    const url = b.image_url?.url ?? b.image_url ?? '';
    const sizeHint = typeof url === 'string' && url.startsWith('data:')
      ? `base64 约 ${Math.round(url.length / 1024)} KB`
      : (typeof url === 'string' && url !== '' ? '远程图片' : '未知');
    return { type: 'text', text: `[图片：${sizeHint}；当前通道不传递图片内容，如需判断请让用户用文字描述]` };
  });
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

  /** 客户端原始 max_tokens（若非空且被抬升，用于诊断）。 */
  let adjustedMaxTokens = null;

  // provider/model 拆分提前：assistant 消息的 source 需要 provider。
  const slash = model.indexOf('/');
  const providerName = slash > 0 && slash < model.length - 1 ? model.slice(0, slash) : model;
  const modelName = slash > 0 && slash < model.length - 1 ? model.slice(slash + 1) : model;

  /** @type {Array<object>} */
  const messages = [];
  /** @type {string[]} */
  const systemParts = [];
  for (const [idx, m] of raw.messages.entries()) {
    if (m === null || typeof m !== 'object') {
      return { ok: false, reason: 'each message must be an object' };
    }
    const role = String(m.role ?? '');
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) {
      return { ok: false, reason: `unsupported message role: ${role}` };
    }
    // DSH 的 Message.content 是 ContentBlock[]，不是字符串（dsh-llm/src/message.ts:143）。
    // 传字符串会让适配器读不到文本块，流正常结束但 content 为空 —— 这个坑只有真调才暴露。
    const rawContent = m.content;
    /** @type {Array<object>} */
    let contentBlocks;
    if (typeof rawContent === 'string') {
      contentBlocks = [{ type: 'text', text: rawContent }];
    } else if (Array.isArray(rawContent)) {
      // 图片已由 preprocessingImages() 在调用本函数**之前**处理完：
      // image_url 已换成 {type:'image', attachment} 或文字占位。
      // 这里**绝不能**再调 degradeImageBlocks —— 它会把已经正确的
      // image 块按类型 again 降级成"图片：未知"文字，导致
      // 「图片明明存成功了，模型却只看到占位文字」。
      contentBlocks = rawContent;
    } else {
      contentBlocks = [{ type: 'text', text: JSON.stringify(rawContent ?? '') }];
    }

    // 消息的稳定 id：OpenAI 客户端不一定给，缺失时按序号生成一个。
    // DSH 的 MessageBase 要求 id（MessageId），同一批内必须唯一。
    const msgId = typeof m.id === 'string' && m.id !== ''
      ? m.id
      : `bridge-msg-${idx}`;

    if (role === 'user') {
      // RequestUserInput 只接受 {role:'user', content}（dsh-llm/src/types.ts:531-536），
      // 不能带 id / source。
      messages.push({ role: 'user', content: contentBlocks });
    } else if (role === 'system') {
      // system 消息转为 GenerateOptions.system（README:581 确认字段存在），
      // 不构造 system 消息本身（它需要 source）。
      const text = contentBlocks.map((b) => (typeof b.text === 'string' ? b.text : '')).join('');
      systemParts.push(text);
    } else if (role === 'assistant') {
      // AssistantMessage = { id, role:'assistant', content, source }（dsh-llm/src/message.ts:167-170）
      // source = { kind:'model', provider, model }（同文件 :24-26）
      //
      // 关键：text 与 tool_calls 必须放在**同一条** assistant 消息的 content 数组里！
      // 之前把每个 tool_call 拆成独立 assistant 消息，导致上游看到一堆空壳
      // assistant + 断裂的调用记录 → "工具调用记录对不上，内容已损坏"(code 11148)。
      // ToolCallBlock = {type:'tool-call', id, name, arguments}（dsh-llm/src/types.ts:112-119），
      // 字段是 `id`（不是 callId）。
      const providerKey = typeof providerName === 'string' ? providerName : model;
      const assistantContent = [...contentBlocks];
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc?.function ?? {};
          assistantContent.push({
            type: 'tool-call',
            id: String(tc?.id ?? ''),
            name: String(fn.name ?? ''),
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          });
        }
      }
      messages.push({
        id: msgId,
        role: 'assistant',
        content: truncateContentBlocks(assistantContent, MAX_ASSISTANT_CHARS),
        source: { kind: 'model', provider: providerKey, model: modelName },
      });
    } else if (role === 'tool') {
      // ToolResultMessage = { id, role:'tool', content, source:{kind:'tool',callId}, toolCallId, isError? }
      // （dsh-llm/src/message.ts:173-180, 29-32）
      //
      // **超长工具结果必须截断**：实测单条工具结果可达 18K 字符，
      // 多轮累积后整个请求达 100K+ 字符（约 30K tokens），
      // 模型上下文被撑爆后退化成英文长篇推理并陷入循环
      // （用户现象：「开始正常，某个调用之后突然爆一大堆英文」）。
      const callId = typeof m.tool_call_id === 'string' ? m.tool_call_id : '';
      contentBlocks = truncateContentBlocks(contentBlocks, MAX_TOOL_RESULT_CHARS);
      messages.push({
        id: msgId,
        role: 'tool',
        content: contentBlocks,
        source: { kind: 'tool', callId },
        toolCallId: callId,
        isError: false,
      });
    }
  }

  /** @type {object} */
  const options = { model: modelName, messages, provider: providerName };
  if (systemParts.length > 0) options.system = systemParts.join('\n');
  if (typeof raw.temperature === 'number') options.temperature = raw.temperature;
  // max_tokens 下限保护：推理模型（workbuddy 等）会先用 token 做思考，
  // 客户端给的值太小时思考就吃光预算，正文一个字都出不来
  // （实测：max_tokens=50 且 finishReason=max-tokens 时 contentLen=0，
  //  手机端表现为「连上了但模型不回复」）。
  // 抬到安全下限，保证思考之后仍有正文预算。
  if (typeof raw.max_tokens === 'number') {
    options.maxTokens = Math.max(raw.max_tokens, MIN_MAX_TOKENS);
    if (options.maxTokens !== raw.max_tokens) {
      adjustedMaxTokens = raw.max_tokens;
    }
  }
  let droppedTools = 0;
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
    // 工具数量上限：手机侧会把「本地全部工具 + 桥的 28 个」一起发来（实测 174 个）。
    // 一次性塞给模型会压垮其指令跟随能力（实测：0 工具时中文正常，
    // 174 工具时退化成英文、自说自话并陷入工具循环）。
    // 策略：优先保留桥的工具（mcp__ 前缀＝电脑能力），其余按原顺序截断。
    const limit = MAX_FORWARDED_TOOLS;
    if (tools.length > limit) {
      const bridgeTools = tools.filter((t) => t.name.startsWith('mcp__'));
      const others = tools.filter((t) => !t.name.startsWith('mcp__'));
      const roomForOthers = Math.max(0, limit - bridgeTools.length);
      const kept = bridgeTools.length <= limit
        ? [...bridgeTools, ...others.slice(0, roomForOthers)]
        : bridgeTools.slice(0, limit);
      droppedTools = tools.length - kept.length;
      options.tools = kept;
    } else if (tools.length > 0) {
      options.tools = tools;
    }
  }

  return { ok: true, options, droppedTools, adjustedMaxTokens };
}
