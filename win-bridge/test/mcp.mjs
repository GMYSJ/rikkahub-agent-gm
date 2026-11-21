/**
 * MCP 兼容端点测试。
 *
 * 目标：证明 RikkaHub 的 `StreamableHttpClientTransport` 能对着
 * `<base>/mcp` 走完握手、列工具、调工具。这直接决定「手机侧零代码接入」是否成立。
 *
 * 运行：node test/mcp.mjs
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MockTools, mountBridge } from './mock-host.mjs';
import {
  MCP_PROTOCOL_VERSION,
  RPC_ERROR,
  rpcResult,
  rpcError,
  toMcpTool,
  parseToolCallParams,
  toMcpCallResult,
  handleMessage,
} from '../lib/mcp.js';

let passed = 0;
let failed = 0;

/**
 * @param {string} name - 用例名。
 * @param {() => Promise<void> | void} body - 用例体。
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

console.log('\n== mcp: 纯函数 ==');
await test('rpcResult 形状正确', () => {
  assert.deepEqual(rpcResult(1, { a: 1 }), { jsonrpc: '2.0', id: 1, result: { a: 1 } });
});
await test('rpcResult 把 undefined result 转成 {}', () => {
  assert.deepEqual(rpcResult(1, undefined).result, {});
});
await test('rpcError 带 code 与 message', () => {
  const out = rpcError(2, RPC_ERROR.METHOD_NOT_FOUND, 'nope');
  assert.equal(out.error.code, -32601);
  assert.equal(out.error.message, 'nope');
});
await test('toMcpTool 保留 object 根 schema', () => {
  const tool = toMcpTool({
    name: 'shell_exec',
    description: 'run',
    parameters: { type: 'object', properties: { c: { type: 'string' } } },
  });
  assert.equal(tool.name, 'shell_exec');
  assert.equal(tool.inputSchema.type, 'object');
  assert.equal(tool.inputSchema.properties.c.type, 'string');
});
await test('toMcpTool 对非 object 根 schema 兜底成空 object', () => {
  const tool = toMcpTool({ name: 'x', parameters: {} });
  assert.deepEqual(tool.inputSchema, { type: 'object', properties: {} });
});
await test('parseToolCallParams 正常解析', () => {
  const out = parseToolCallParams({ name: 'a', arguments: { b: 1 } });
  assert.equal(out.ok, true);
  assert.equal(out.name, 'a');
  assert.deepEqual(out.args, { b: 1 });
});
await test('parseToolCallParams 缺 name 拒绝', () => {
  assert.equal(parseToolCallParams({}).ok, false);
});
await test('parseToolCallParams arguments 非对象拒绝', () => {
  assert.equal(parseToolCallParams({ name: 'a', arguments: [1] }).ok, false);
});
await test('toMcpCallResult 成功时搬运 text 块', () => {
  const out = toMcpCallResult({ ok: true, value: {}, content: [{ type: 'text', text: 'hello' }] });
  assert.deepEqual(out.content, [{ type: 'text', text: 'hello' }]);
  assert.equal(out.isError, undefined);
});
await test('toMcpCallResult 无 text 块时用 value 兜底', () => {
  const out = toMcpCallResult({ ok: true, value: { n: 1 }, content: [] });
  assert.match(out.content[0].text, /"n": 1/);
});
await test('toMcpCallResult 失败时带 isError', () => {
  const out = toMcpCallResult({ ok: false, error: { code: 'tool_failed', message: 'boom' } });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /tool_failed: boom/);
});

console.log('\n== mcp: handleMessage 协议 ==');
const fakeHandlers = {
  listTools: () => [{ name: 'echo', description: 'e', parameters: { type: 'object', properties: {} } }],
  callTool: async (name, args) => ({ ok: true, value: { echoed: args }, content: [] }),
};

await test('initialize 返回协议版本与 capabilities', async () => {
  const out = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, fakeHandlers);
  assert.equal(out.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(out.result.capabilities.tools.listChanged, false);
  assert.equal(out.result.serverInfo.name, 'dsh-mobile-bridge');
});
await test('notifications/initialized 不响应', async () => {
  const out = await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, fakeHandlers);
  assert.equal(out, null);
});
await test('ping 返回空结果', async () => {
  const out = await handleMessage({ jsonrpc: '2.0', id: 9, method: 'ping' }, fakeHandlers);
  assert.deepEqual(out.result, {});
});
await test('tools/list 返回 inputSchema', async () => {
  const out = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, fakeHandlers);
  assert.equal(out.result.tools.length, 1);
  assert.equal(out.result.tools[0].inputSchema.type, 'object');
});
await test('tools/call 执行并返回 content', async () => {
  const out = await handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { x: 1 } } },
    fakeHandlers,
  );
  assert.equal(out.result.isError, undefined);
  assert.match(out.result.content[0].text, /"x": 1/);
});
await test('tools/call 缺 name 返回 INVALID_PARAMS', async () => {
  const out = await handleMessage(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} },
    fakeHandlers,
  );
  assert.equal(out.error.code, RPC_ERROR.INVALID_PARAMS);
});
await test('未知方法返回 METHOD_NOT_FOUND', async () => {
  const out = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, fakeHandlers);
  assert.equal(out.error.code, RPC_ERROR.METHOD_NOT_FOUND);
});
await test('非 2.0 的 jsonrpc 被拒', async () => {
  const out = await handleMessage({ jsonrpc: '1.0', id: 6, method: 'ping' }, fakeHandlers);
  assert.equal(out.error.code, RPC_ERROR.INVALID_REQUEST);
});
await test('工具抛异常时返回 isError 结果而不是协议错误', async () => {
  const out = await handleMessage(
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'boom' } },
    { listTools: () => [], callTool: async () => { throw new Error('kaboom'); } },
  );
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /kaboom/);
  assert.equal(out.error, undefined);
});

console.log('\n== mcp: HTTP 端到端 ==');
const tools = new MockTools();
const { handler, teardown } = mountBridge(tools, { enabled: true, listenPath: '/bridge', selfNodeId: 'windows-dsh' });
tools.add({
  name: 'shell_exec',
  description: '执行命令',
  parameters: { command: { type: 'string', required: true } },
  run: async (args) => ({ output: `ran: ${args.command}` }),
});

const server = createServer((req, res) => { void handler(req, res); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const MCP_URL = `${origin}/bridge/mcp`;

/**
 * @param {object} payload - JSON-RPC 消息。
 * @returns {Promise<{status: number, json: any}>}
 */
async function rpc(payload) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text) };
}

await test('HTTP initialize 成功', async () => {
  const out = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(out.status, 200);
  assert.equal(out.json.result.protocolVersion, MCP_PROTOCOL_VERSION);
});
await test('HTTP notifications/initialized 返回 202 空正文', async () => {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), '');
});
await test('HTTP tools/list 列出 DSH 工具', async () => {
  const out = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = out.json.result.tools.map((t) => t.name);
  assert.ok(names.includes('shell_exec'));
});
await test('HTTP tools/call 真的执行了工具', async () => {
  const before = tools.calls.length;
  const out = await rpc({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'shell_exec', arguments: { command: 'ls' } },
  });
  assert.match(JSON.stringify(out.json.result.content), /ran: ls/);
  assert.equal(tools.calls.length, before + 1);
});
await test('批量请求返回数组', async () => {
  const out = await rpc([
    { jsonrpc: '2.0', id: 10, method: 'ping' },
    { jsonrpc: '2.0', id: 11, method: 'tools/list' },
  ]);
  assert.equal(Array.isArray(out.json), true);
  assert.equal(out.json.length, 2);
});
await test('坏 JSON 返回 PARSE_ERROR 且状态 200', async () => {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad',
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.error.code, RPC_ERROR.PARSE_ERROR);
});
await test('GET /mcp 返回 405（不提供推送流）', async () => {
  const res = await fetch(MCP_URL);
  assert.equal(res.status, 405);
});
await test('MCP 端点的工具清单不含 mcp__ 前缀工具（防自我回显）', async () => {
  // 先注册一个远端工具
  await fetch(`${origin}/bridge/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      node: 'phone',
      baseUrl: 'http://127.0.0.1:1/nowhere',
      tools: [{ name: 'get_battery' }],
    }),
  });
  const out = await rpc({ jsonrpc: '2.0', id: 20, method: 'tools/list' });
  const names = out.json.result.tools.map((t) => t.name);
  assert.equal(names.some((n) => n.startsWith('mcp__')), false);
});
await test('MCP 端点也受跳数预算保护', async () => {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-hop-count': '2' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tools/list' }),
  });
  assert.equal(res.status, 508);
});

teardown();
await new Promise((resolve) => server.close(resolve));

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exitCode = 1;
