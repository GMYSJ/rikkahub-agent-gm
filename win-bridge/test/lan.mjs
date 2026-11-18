/**
 * 局域网监听测试。
 *
 * 两段：
 *  1. 配置校验（纯函数）—— 重点是**拒绝通配地址、拒绝回环、强制 token**；
 *  2. 真实监听 —— 起一个真的 http server，验证路由复用与独立令牌生效。
 *
 * 运行：node test/lan.mjs
 */

import assert from 'node:assert/strict';
import {
  validateLanOptions,
  startLanListener,
  DEFAULT_LAN_PORT,
} from '../lib/lan.js';
import { MockTools, mountBridge } from './mock-host.mjs';
import { ERROR_CODE } from '../lib/protocol.js';

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

const GOOD_TOKEN = 'a'.repeat(32);

console.log('\n== lan: 配置校验 ==');
await test('合法配置通过', () => {
  const v = validateLanOptions({ host: '192.168.1.3', port: 61420, token: GOOD_TOKEN });
  assert.equal(v.ok, true);
  assert.equal(v.host, '192.168.1.3');
  assert.equal(v.port, 61420);
});
await test('拒绝 0.0.0.0（会把桥暴露到所有网卡）', () => {
  const v = validateLanOptions({ host: '0.0.0.0', port: 61420, token: GOOD_TOKEN });
  assert.equal(v.ok, false);
  assert.match(v.reason, /all networks/);
});
await test('拒绝 ::', () => {
  assert.equal(validateLanOptions({ host: '::', port: 61420, token: GOOD_TOKEN }).ok, false);
});
await test('拒绝通配符 *', () => {
  assert.equal(validateLanOptions({ host: '*', port: 61420, token: GOOD_TOKEN }).ok, false);
});
await test('拒绝回环地址（等于没做这件事）', () => {
  const v = validateLanOptions({ host: '127.0.0.1', port: 61420, token: GOOD_TOKEN });
  assert.equal(v.ok, false);
  assert.match(v.reason, /loopback/);
});
await test('拒绝 localhost', () => {
  assert.equal(validateLanOptions({ host: 'localhost', port: 61420, token: GOOD_TOKEN }).ok, false);
});
await test('拒绝非 IPv4 字面量', () => {
  assert.equal(validateLanOptions({ host: 'example.com', port: 61420, token: GOOD_TOKEN }).ok, false);
});
await test('缺 host 被拒', () => {
  assert.equal(validateLanOptions({ port: 61420, token: GOOD_TOKEN }).ok, false);
});
await test('端口越界被拒', () => {
  assert.equal(validateLanOptions({ host: '192.168.1.3', port: 0, token: GOOD_TOKEN }).ok, false);
  assert.equal(validateLanOptions({ host: '192.168.1.3', port: 70000, token: GOOD_TOKEN }).ok, false);
});
await test('端口非整数被拒', () => {
  assert.equal(validateLanOptions({ host: '192.168.1.3', port: 'abc', token: GOOD_TOKEN }).ok, false);
});
await test('缺 token 被拒（局域网暴露必须鉴权）', () => {
  const v = validateLanOptions({ host: '192.168.1.3', port: 61420 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /token is required/);
});
await test('token 太短被拒', () => {
  assert.equal(validateLanOptions({ host: '192.168.1.3', port: 61420, token: 'short' }).ok, false);
});
await test('默认端口常量合理', () => {
  assert.ok(Number.isInteger(DEFAULT_LAN_PORT));
  assert.ok(DEFAULT_LAN_PORT > 1024 && DEFAULT_LAN_PORT < 65535);
});

console.log('\n== lan: 真实监听 ==');
// 起一个桥，用 mock 宿主
const tools = new MockTools();
const { handler, teardown } = mountBridge(tools, { enabled: true, listenPath: '/bridge', selfNodeId: 'windows-dsh' });
tools.add({
  name: 'echo',
  description: '回显',
  parameters: { msg: { type: 'string', required: true } },
  run: async (args) => ({ echoed: args.msg }),
});

// 监听 127.0.0.1 只是为了测试（validateLanOptions 会拒绝它，
// 但 startLanListener 本身不做策略判断，策略在 config 层）。
const started = await startLanListener({
  host: '127.0.0.1',
  port: 0,          // 让 OS 分配，避免与真实端口冲突
  handler,
});
// 注意：port 0 时实际端口要从 server 拿，这里改为显式取一个空闲端口
if (started.ok) { await started.close(); }

/**
 * 找一个空闲端口。
 * @returns {Promise<number>}
 */
async function freePort() {
  const { createServer } = await import('node:http');
  const s = createServer(() => {});
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

const port = await freePort();
const listener = await startLanListener({ host: '127.0.0.1', port, handler });
await test('监听成功启动', () => {
  assert.equal(listener.ok, true);
  assert.equal(listener.address.port, port);
});
await test('局域网监听复用同一份 handler：/health 可用', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/bridge/health`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.result.nodeId, 'windows-dsh');
});
await test('局域网监听上 /tools 列出工具', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/bridge/tools`);
  const json = await res.json();
  assert.ok(json.result.tools.some((t) => t.name === 'echo'));
});
await test('局域网监听上 /tools/call 真的执行', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/bridge/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'echo', arguments: { msg: 'lan' } }),
  });
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.match(JSON.stringify(json.result), /lan/);
});
await test('局域网监听上 MCP 端点也可用', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/bridge/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  const json = await res.json();
  assert.equal(json.result.serverInfo.name, 'dsh-mobile-bridge');
});
await test('局域网监听上跳数防护照样生效', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/bridge/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-hop-count': '2' },
    body: JSON.stringify({ tool: 'echo', arguments: { msg: 'x' } }),
  });
  assert.equal(res.status, 508);
});
await test('handler 抛异常不崩监听', async () => {
  const bad = await startLanListener({
    host: '127.0.0.1',
    port: await freePort(),
    handler: async () => { throw new Error('boom'); },
  });
  assert.equal(bad.ok, true);
  const res = await fetch(`http://127.0.0.1:${bad.address.port}/anything`);
  assert.equal(res.status, 500);
  const json = await res.json();
  assert.equal(json.error.code, 'internal');
  await bad.close();
});
await test('close() 能释放端口', async () => {
  const p = await freePort();
  const l = await startLanListener({ host: '127.0.0.1', port: p, handler });
  assert.equal(l.ok, true);
  await l.close();
  // 端口应可再绑
  const again = await startLanListener({ host: '127.0.0.1', port: p, handler });
  assert.equal(again.ok, true);
  await again.close();
});
await test('端口被占用时明确失败而不是静默', async () => {
  const p = await freePort();
  const first = await startLanListener({ host: '127.0.0.1', port: p, handler });
  assert.equal(first.ok, true);
  const second = await startLanListener({ host: '127.0.0.1', port: p, handler });
  assert.equal(second.ok, false);
  assert.match(second.reason, /already in use/);
  await first.close();
});
await test('绑定不存在的地址时明确失败', async () => {
  const r = await startLanListener({ host: '10.255.255.123', port: await freePort(), handler });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not an address of this machine|EADDRNOTAVAIL|not available/i);
});

console.log('\n== lan: 诊断端点（证明「调过」而不只是「看见」）==');
await test('诊断端点返回结构完整的统计', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/bridge/diagnostics`);
  const json = await res.json();
  assert.equal(json.ok, true);
  // 注意：前面的用例已经调过工具，所以这里不能断言 calls === 0，
  // 只能断言结构完整、计数自洽。
  assert.equal(typeof json.result.totals.calls, 'number');
  assert.equal(typeof json.result.totals.succeeded, 'number');
  assert.equal(typeof json.result.totals.failed, 'number');
  assert.equal(
    json.result.totals.calls,
    json.result.totals.succeeded + json.result.totals.failed,
    '成功 + 失败 应等于总数',
  );
  assert.ok(Array.isArray(json.result.recent));
});
await test('调一次工具后诊断有记录', async () => {
  await fetch(`http://127.0.0.1:${port}/bridge/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'echo', arguments: { msg: 'diag' } }),
  });
  const res = await fetch(`http://127.0.0.1:${port}/bridge/diagnostics`);
  const json = await res.json();
  assert.ok(json.result.totals.calls >= 1, '应至少记录 1 次调用');
  assert.ok(json.result.totals.succeeded >= 1, '应至少 1 次成功');
  const recent = json.result.recent[0];
  assert.equal(recent.tool, 'echo');
  assert.equal(recent.ok, true);
  assert.equal(recent.via, 'native');
  assert.equal(typeof recent.ms, 'number');
  assert.equal(typeof recent.peer, 'string');
});
await test('MCP 调用被记为 via=mcp（能区分走哪条路）', async () => {
  await fetch(`http://127.0.0.1:${port}/bridge/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'x' } } }),
  });
  const res = await fetch(`http://127.0.0.1:${port}/bridge/diagnostics`);
  const json = await res.json();
  assert.ok(json.result.byVia.mcp >= 1, 'MCP 调用应被单独计数');
  assert.ok(json.result.byVia.native >= 1, '原生调用应被单独计数');
});
await test('失败的调用也被记下并带错误码', async () => {
  await fetch(`http://127.0.0.1:${port}/bridge/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'no_such_tool', arguments: {} }),
  });
  const res = await fetch(`http://127.0.0.1:${port}/bridge/diagnostics`);
  const json = await res.json();
  const failed = json.result.recent.find((c) => c.tool === 'no_such_tool');
  assert.ok(failed !== undefined, '失败调用应出现');
  assert.equal(failed.ok, false);
  assert.equal(typeof failed.errorCode, 'string');
});
await test('诊断不泄漏参数与结果', async () => {
  await fetch(`http://127.0.0.1:${port}/bridge/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'echo', arguments: { msg: 'SECRET_SHOULD_NOT_APPEAR' } }),
  });
  const res = await fetch(`http://127.0.0.1:${port}/bridge/diagnostics`);
  const text = await res.text();
  assert.equal(text.includes('SECRET_SHOULD_NOT_APPEAR'), false, '参数绝不能出现在诊断里');
});

await listener.close();
teardown();

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exitCode = 1;
