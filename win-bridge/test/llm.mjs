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
test('reasoning-delta 不泄漏思考文本（保守）', () => {
  const r = chunkToSse({ type: 'reasoning-delta', index: 0, text: '内部思考SECRET' }, {
    id: 'x', model: 'm', roleSent: true,
  });
  assert.equal(r.frames.length, 1);
  const frame = r.frames[0];
  assert.equal(frame.includes('SECRET'), false);
  assert.equal(parseFrame(frame).choices[0].delta.content, '');
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
  assert.equal(r.options.messages[0].content, '你好');
  assert.equal(r.options.temperature, 0.7);
  assert.equal(r.options.maxTokens, 100);
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
test('未知 role 被拒', () => {
  assert.equal(openAiRequestToGenerateOptions({
    model: 'm', messages: [{ role: 'hacker', content: 'x' }],
  }).ok, false);
});
test('非字符串 content 降级成 JSON 文本而不丢消息', () => {
  const r = openAiRequestToGenerateOptions({
    model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });
  assert.equal(r.ok, true);
  assert.match(r.options.messages[0].content, /"text":"hi"/);
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
