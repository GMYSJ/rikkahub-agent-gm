/**
 * 模型门面转换层测试（纯逻辑）。
 *
 * 运行：node test/llm.mjs
 */

import assert from 'node:assert/strict';
import {
  CHUNK_ID_PREFIX,
  newCompletionId,
  sseFrame,
  SSE_DONE,
  chunkToSse,
  mapFinishReason,
  normalizeUsage,
  openAiRequestToGenerateOptions,
} from '../lib/llm.js';

let passed = 0;
let failed = 0;

/**
 * @param {string} name - 用例名。
 * @param {() => void} body - 用例体。
 */
function test(name, body) {
  try {
    body();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 从 SSE 帧里取 JSON。
 * @param {string} frame - SSE 文本。
 * @returns {object}
 */
function parseFrame(frame) {
  assert.ok(frame.startsWith('data: '), '必须是 data 帧');
  return JSON.parse(frame.slice(6).trim());
}

console.log('\n== llm: 基础工具 ==');
test('completion id 带正确前缀', () => {
  const id = newCompletionId();
  assert.ok(id.startsWith(CHUNK_ID_PREFIX));
  assert.ok(id.length > CHUNK_ID_PREFIX.length);
});
test('SSE 帧格式正确（data: + 双换行）', () => {
  const frame = sseFrame({ id: 'x', model: 'm', delta: { content: 'hi' } });
  assert.ok(frame.startsWith('data: '));
  assert.ok(frame.endsWith('\n\n'));
});
test('SSE 帧结构符合 OpenAI', () => {
  const frame = sseFrame({ id: 'x', model: 'm', delta: { content: 'hi' } });
  const obj = parseFrame(frame);
  assert.equal(obj.object, 'chat.completion.chunk');
  assert.equal(obj.choices[0].delta.content, 'hi');
  assert.equal(obj.choices[0].finish_reason, null);
});
test('[DONE] 帧正确', () => {
  assert.equal(SSE_DONE, 'data: [DONE]\n\n');
});

console.log('\n== llm: StreamChunk 映射 ==');
test('block-start 发 role 帧', () => {
  const r = chunkToSse({ type: 'block-start', index: 0, blockType: 'text' }, {
    id: 'x', model: 'm', roleSent: false,
  });
  assert.equal(r.frames.length, 1);
  assert.equal(parseFrame(r.frames[0]).choices[0].delta.role, 'assistant');
  assert.equal(r.roleSent, true);
});
test('role 只发一次', () => {
  const first = chunkToSse({ type: 'block-start', index: 0, blockType: 'text' }, {
    id: 'x', model: 'm', roleSent: false,
  });
  const second = chunkToSse({ type: 'text-delta', index: 0, text: 'hi' }, {
    id: 'x', model: 'm', roleSent: first.roleSent,
  });
  assert.equal(second.frames.length, 1);
  assert.equal(parseFrame(second.frames[0]).choices[0].delta.content, 'hi');
  assert.equal(parseFrame(second.frames[0]).choices[0].delta.role, undefined);
});
test('text-delta 映射为 content', () => {
  const r = chunkToSse({ type: 'text-delta', index: 0, text: '你好' }, {
    id: 'x', model: 'm', roleSent: true,
  });
  assert.equal(parseFrame(r.frames[0]).choices[0].delta.content, '你好');
});
test('reasoning-delta 只走 reasoning_content，不刷屏正文', () => {
  const r = chunkToSse({ type: 'reasoning-delta', index: 0, text: '思考文本' }, {
    id: 'x', model: 'm', roleSent: true,
  });
  assert.equal(r.frames.length, 1);
  const d = parseFrame(r.frames[0]).choices[0].delta;
  assert.equal(d.reasoning_content, '思考文本');
  assert.equal(d.content, undefined, '思考分片绝不能当正文发，否则会刷屏切碎对话');
});
test('全 reasoning 无正文时 finish 一次性兜底 content', () => {
  const ctx = { id: 'x', model: 'm', roleSent: true, reasoningBuffer: '', hasText: false };
  chunkToSse({ type: 'reasoning-delta', index: 0, text: '第一段' }, ctx);
  chunkToSse({ type: 'reasoning-delta', index: 1, text: '第二段' }, ctx);
  const r = chunkToSse({ type: 'finish', reason: 'stop' }, ctx);
  // finish 应产生：兜底 content 帧 + finish 帧
  const contents = r.frames.map((f) => parseFrame(f).choices[0].delta.content).filter(Boolean);
  assert.equal(contents.length, 1, '兜底内容必须一次性发，不能多帧');
  assert.equal(contents[0], '第一段第二段');
});
test('没有 block-start 时 text-delta 自动补 role', () => {
  const r = chunkToSse({ type: 'text-delta', index: 0, text: 'hi' }, {
    id: 'x', model: 'm', roleSent: false,
  });
  assert.equal(r.frames.length, 2);
  assert.equal(parseFrame(r.frames[0]).choices[0].delta.role, 'assistant');
  assert.equal(parseFrame(r.frames[1]).choices[0].delta.content, 'hi');
});
test('tool-call-delta 首次带 id/name', () => {
  const r = chunkToSse({
    type: 'tool-call-delta', index: 0, id: 'call_1', name: 'fs_read', argumentsDelta: '{"path":',
  }, { id: 'x', model: 'm', roleSent: true });
  const tc = parseFrame(r.frames[0]).choices[0].delta.tool_calls[0];
  assert.equal(tc.id, 'call_1');
  assert.equal(tc.type, 'function');
  assert.equal(tc.function.name, 'fs_read');
  assert.equal(tc.function.arguments, '{"path":');
});
test('tool-call-delta 后续只有参数增量', () => {
  const r = chunkToSse({
    type: 'tool-call-delta', index: 0, argumentsDelta: '"/x"}',
  }, { id: 'x', model: 'm', roleSent: true });
  const tc = parseFrame(r.frames[0]).choices[0].delta.tool_calls[0];
  assert.equal(tc.id, undefined);
  assert.equal(tc.function.arguments, '"/x"}');
});
test('block-end 不产生帧', () => {
  const r = chunkToSse({ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } }, {
    id: 'x', model: 'm', roleSent: true,
  });
  assert.equal(r.frames.length, 0);
});
test('usage 暂存不带帧', () => {
  const r = chunkToSse({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }, {
    id: 'x', model: 'm', roleSent: true,
  });
  assert.equal(r.frames.length, 0);
  assert.equal(r.pendingUsage.prompt_tokens, 10);
});
test('finish 带 finish_reason', () => {
  const r = chunkToSse({ type: 'finish', reason: 'stop' }, {
    id: 'x', model: 'm', roleSent: true,
  });
  assert.equal(parseFrame(r.frames[0]).choices[0].finish_reason, 'stop');
});
test('finish 合并暂存的 usage', () => {
  const u = chunkToSse({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }, {
    id: 'x', model: 'm', roleSent: true,
  });
  const r = chunkToSse({ type: 'finish', reason: 'stop' }, {
    id: 'x', model: 'm', roleSent: true, pendingUsage: u.pendingUsage,
  });
  const obj = parseFrame(r.frames[0]);
  assert.equal(obj.usage.prompt_tokens, 10);
  assert.equal(obj.usage.total_tokens, 15);
});

console.log('\n== llm: finish reason 映射 ==');
test('tool_calls 映射', () => {
  assert.equal(mapFinishReason('tool_calls'), 'tool_calls');
  assert.equal(mapFinishReason('tool-call'), 'tool_calls');
});
test('length 映射', () => {
  assert.equal(mapFinishReason('length'), 'length');
  assert.equal(mapFinishReason('max_tokens'), 'length');
});
test('异常结束映射为 stop', () => {
  assert.equal(mapFinishReason('cancelled'), 'stop');
  assert.equal(mapFinishReason('error'), 'stop');
  assert.equal(mapFinishReason(null), 'stop');
});

console.log('\n== llm: usage 归一化 ==');
test('DSH inputTokens/outputTokens 映射', () => {
  const u = normalizeUsage({ inputTokens: 20, outputTokens: 8 });
  assert.equal(u.prompt_tokens, 20);
  assert.equal(u.completion_tokens, 8);
  assert.equal(u.total_tokens, 28);
});
test('非对象返回 undefined', () => {
  assert.equal(normalizeUsage(null), undefined);
  assert.equal(normalizeUsage('x'), undefined);
});

console.log('\n== llm: 请求转换 ==');
test('合法请求转换成功', () => {
  const r = openAiRequestToGenerateOptions({
    model: 'workbuddy/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: '你好' }],
    temperature: 0.7,
    max_tokens: 100,
  });
  assert.equal(r.ok, true);
  assert.equal(r.options.model, 'deepseek-v4.1-flash');
  assert.equal(r.options.provider, 'workbuddy');
  // content 必须是 ContentBlock[]，不能是裸字符串
  assert.deepEqual(r.options.messages[0].content, [{ type: 'text', text: '你好' }]);
  assert.equal(r.options.temperature, 0.7);
  assert.equal(r.options.maxTokens, 100);
});
test('system 消息转到 GenerateOptions.system，不构造 system 消息', () => {
  const r = openAiRequestToGenerateOptions({
    model: 'm',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: 'hi' },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.options.system, '你是助手');
  assert.equal(r.options.messages.length, 1);
  assert.equal(r.options.messages[0].role, 'user');
});
test('model 无斜杠时 provider 与 model 用同值', () => {
  const r = openAiRequestToGenerateOptions({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.options.provider, 'deepseek-v4-flash');
  assert.equal(r.options.model, 'deepseek-v4-flash');
});
test('缺 model 被拒', () => {
  assert.equal(openAiRequestToGenerateOptions({ messages: [{ role: 'user', content: 'x' }] }).ok, false);
});
test('缺 messages 被拒', () => {
  assert.equal(openAiRequestToGenerateOptions({ model: 'm' }).ok, false);
});
test('空 messages 被拒', () => {
  assert.equal(openAiRequestToGenerateOptions({ model: 'm', messages: [] }).ok, false);
});
test('assistant 消息转成 DSH 完整结构（多轮对话必需）', () => {
  const r = openAiRequestToGenerateOptions({
    model: 'workbuddy/deepseek-v4.1-flash',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
  });
  assert.equal(r.ok, true);
  const a = r.options.messages.find((m) => m.role === 'assistant');
  assert.ok(a !== undefined);
  assert.equal(a.source.kind, 'model');
  assert.equal(a.source.provider, 'workbuddy');
  assert.equal(a.source.model, 'deepseek-v4.1-flash');
  assert.deepEqual(a.content, [{ type: 'text', text: 'hello' }]);
});
test('tool 消息转成 DSH ToolResultMessage 结构', () => {
  const r = openAiRequestToGenerateOptions({
    model: 'm',
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'fs_read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ],
  });
  assert.equal(r.ok, true);
  const t = r.options.messages.find((m) => m.role === 'tool');
  assert.ok(t !== undefined);
  assert.equal(t.source.kind, 'tool');
  assert.equal(t.toolCallId, 'call_1');
  assert.equal(t.source.callId, 'call_1');
});
test('非字符串 content 降级成文本块而不丢消息', () => {
  const r = openAiRequestToGenerateOptions({
    model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.options.messages[0].content, [{ type: 'text', text: 'hi' }]);
});
test('tools 数组转换', () => {
  const r = openAiRequestToGenerateOptions({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{
      type: 'function',
      function: { name: 'fs_read', description: 'read', parameters: { type: 'object', properties: {} } },
    }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.options.tools[0].name, 'fs_read');
  assert.equal(r.options.tools[0].description, 'read');
});
test('非 body 被拒', () => {
  assert.equal(openAiRequestToGenerateOptions(null).ok, false);
  assert.equal(openAiRequestToGenerateOptions([]).ok, false);
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exitCode = 1;
