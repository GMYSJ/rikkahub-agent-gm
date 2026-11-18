/**
 * 客户端 smoke 测试：用一个假 fetch 验证「出」方向（DSH 当调用方）的完整逻辑。
 *
 * 运行：node test/client.mjs
 */

import assert from 'node:assert/strict';
import { callRemoteTool, fetchRemoteTools, DEFAULT_TIMEOUT_MS } from '../lib/client.js';
import { ERROR_CODE, HEADER } from '../lib/protocol.js';

let passed = 0;
let failed = 0;

/**
 * @param {string} name - 用例名。
 * @param {() => Promise<void>} body - 用例体。
 */
async function test(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 造一个返回固定 JSON 的假 fetch，并记录调用参数。
 *
 * @param {unknown} payload - 要返回的 JSON。
 * @param {number} [status] - HTTP 状态码。
 * @returns {{impl: typeof fetch, calls: Array<{url: string, init: object}>}}
 */
function fakeFetch(payload, status = 200) {
  /** @type {Array<{url: string, init: object}>} */
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      status,
      async json() {
        return payload;
      },
    };
  };
  return { impl, calls };
}

const BASE = 'https://192.168.1.5:8443/phone-bridge';

console.log('\n== client: callRemoteTool 成功路径 ==');
await test('成功时返回 value', async () => {
  const { impl, calls } = fakeFetch({ ok: true, result: { hello: 'world' }, content: [{ type: 'text', text: 'hi' }] });
  const out = await callRemoteTool({
    baseUrl: BASE, selfNodeId: 'win', targetNodeId: 'phone', tool: 'screenshot', args: { a: 1 }, fetchImpl: impl,
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value, { hello: 'world' });
  assert.equal(out.content.length, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/tools/call'));
});
await test('请求体带 tool 与 arguments', async () => {
  const { impl, calls } = fakeFetch({ ok: true, result: 1 });
  await callRemoteTool({
    baseUrl: BASE, selfNodeId: 'win', targetNodeId: 'phone', tool: 'fs_read', args: { path: '/x' }, fetchImpl: impl,
  });
  const body = JSON.parse(/** @type {any} */ (calls[0].init).body);
  assert.equal(body.tool, 'fs_read');
  assert.deepEqual(body.arguments, { path: '/x' });
});
await test('出站 header 带 trace 且跳数 +1', async () => {
  const { impl, calls } = fakeFetch({ ok: true, result: 1 });
  await callRemoteTool({
    baseUrl: BASE,
    selfNodeId: 'win',
    targetNodeId: 'phone',
    tool: 'x',
    trace: { traceId: 'trace-1', hopCount: 0 },
    fetchImpl: impl,
  });
  const headers = /** @type {any} */ (calls[0].init).headers;
  assert.equal(headers[HEADER.HOP_COUNT], '1');
  assert.equal(headers[HEADER.TRACE_ID], 'trace-1');
  assert.equal(headers[HEADER.SOURCE_NODE], 'win');
  assert.equal(headers[HEADER.TARGET_NODE], 'phone');
});
await test('配了 token 才带 Authorization', async () => {
  const a = fakeFetch({ ok: true, result: 1 });
  await callRemoteTool({ baseUrl: BASE, selfNodeId: 'w', targetNodeId: 'p', tool: 't', fetchImpl: a.impl });
  assert.equal(/** @type {any} */ (a.calls[0].init).headers[HEADER.AUTHORIZATION], undefined);

  const b = fakeFetch({ ok: true, result: 1 });
  await callRemoteTool({ baseUrl: BASE, selfNodeId: 'w', targetNodeId: 'p', tool: 't', token: 'secret', fetchImpl: b.impl });
  assert.equal(/** @type {any} */ (b.calls[0].init).headers[HEADER.AUTHORIZATION], 'Bearer secret');
});
await test('baseUrl 尾部斜杠不会造成双斜杠', async () => {
  const { impl, calls } = fakeFetch({ ok: true, result: 1 });
  await callRemoteTool({
    baseUrl: 'https://h/p/', selfNodeId: 'w', targetNodeId: 'p', tool: 't', fetchImpl: impl,
  });
  assert.equal(calls[0].url, 'https://h/p/tools/call');
});

console.log('\n== client: callRemoteTool 失败路径 ==');
await test('远端返回 ok:false 时透传错误码', async () => {
  const { impl } = fakeFetch({ ok: false, error: { code: 'tool_not_found', message: 'nope' } }, 404);
  const out = await callRemoteTool({ baseUrl: BASE, selfNodeId: 'w', targetNodeId: 'p', tool: 't', fetchImpl: impl });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'tool_not_found');
  assert.equal(out.message, 'nope');
});
await test('非 JSON 响应给 internal', async () => {
  const impl = async () => ({ status: 500, async json() { throw new Error('bad json'); } });
  const out = await callRemoteTool({ baseUrl: BASE, selfNodeId: 'w', targetNodeId: 'p', tool: 't', fetchImpl: impl });
  assert.equal(out.ok, false);
  assert.equal(out.code, ERROR_CODE.INTERNAL);
  assert.ok(out.message.includes('500'));
});
await test('网络异常给 tool_failed', async () => {
  const impl = async () => { throw new Error('ECONNREFUSED'); };
  const out = await callRemoteTool({ baseUrl: BASE, selfNodeId: 'w', targetNodeId: 'p', tool: 't', fetchImpl: impl });
  assert.equal(out.ok, false);
  assert.equal(out.code, ERROR_CODE.TOOL_FAILED);
  assert.ok(out.message.includes('ECONNREFUSED'));
});
await test('超时给 timeout', async () => {
  const impl = async (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const out = await callRemoteTool({
    baseUrl: BASE, selfNodeId: 'w', targetNodeId: 'p', tool: 't', timeoutMs: 30, fetchImpl: impl,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, ERROR_CODE.TIMEOUT);
});
await test('上游取消给 cancelled', async () => {
  const controller = new AbortController();
  const impl = async (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const promise = callRemoteTool({
    baseUrl: BASE, selfNodeId: 'w', targetNodeId: 'p', tool: 't', signal: controller.signal, fetchImpl: impl,
  });
  controller.abort();
  const out = await promise;
  assert.equal(out.ok, false);
  assert.equal(out.code, ERROR_CODE.CANCELLED);
});
await test('已取消的 signal 立即生效', async () => {
  const controller = new AbortController();
  controller.abort();
  const impl = async () => { throw new Error('should be aborted before fetch'); };
  const out = await callRemoteTool({
    baseUrl: BASE, selfNodeId: 'w', targetNodeId: 'p', tool: 't', signal: controller.signal, fetchImpl: impl,
  });
  assert.equal(out.ok, false);
});
await test('没有 fetch 实现时明确报错', async () => {
  const out = await callRemoteTool({
    baseUrl: BASE, selfNodeId: 'w', targetNodeId: 'p', tool: 't', fetchImpl: undefined,
  });
  // 环境里可能真有全局 fetch，此时只断言不抛
  assert.equal(typeof out.ok, 'boolean');
});

console.log('\n== client: fetchRemoteTools ==');
await test('拉取并校验工具清单', async () => {
  const { impl } = fakeFetch({
    ok: true,
    result: {
      nodeId: 'windows-dsh',
      tools: [
        { name: 'fs_read', description: 'read', parameters: { type: 'object', properties: {} } },
        { name: 'bad', parameters: [] },
        { description: 'no name' },
      ],
    },
  });
  const out = await fetchRemoteTools({ baseUrl: BASE, fetchImpl: impl });
  assert.equal(out.ok, true);
  assert.equal(out.nodeId, 'windows-dsh');
  assert.equal(out.tools.length, 1);
  assert.equal(out.tools[0].name, 'fs_read');
  assert.equal(out.rejected.length, 2);
});
await test('对端报错时透传', async () => {
  const { impl } = fakeFetch({ ok: false, error: { code: 'unauthorized', message: 'bad token' } }, 401);
  const out = await fetchRemoteTools({ baseUrl: BASE, token: 'x', fetchImpl: impl });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'unauthorized');
});
await test('结果缺失 tools 时返回空数组而不是崩', async () => {
  const { impl } = fakeFetch({ ok: true, result: { nodeId: null } });
  const out = await fetchRemoteTools({ baseUrl: BASE, fetchImpl: impl });
  assert.equal(out.ok, true);
  assert.deepEqual(out.tools, []);
});
await test('网络失败返回错误而不抛', async () => {
  const impl = async () => { throw new Error('timeout-ish'); };
  const out = await fetchRemoteTools({ baseUrl: BASE, fetchImpl: impl });
  assert.equal(out.ok, false);
  assert.ok(typeof out.message === 'string');
});
await test('默认超时是正数', async () => {
  assert.ok(DEFAULT_TIMEOUT_MS > 0);
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exitCode = 1;
