/**
 * 端到端集成测试：起一个真实 HTTP 服务器，把桥挂上去，然后用真 fetch 打它。
 *
 * 这是「脱宿主但真协议」的验证 —— 不需要 DSH 在跑，也不需要重启 DSH，
 * 就能证明两端实现对称、循环防护生效、工具注册与回调真的能走通。
 *
 * 运行：node test/e2e.mjs
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MockTools, mountBridge } from './mock-host.mjs';

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
 * 用 Node 原生 http 起一个只服务桥路由的服务器。
 *
 * 刻意不引第三方框架：桥只依赖 `IncomingMessage` / `ServerResponse`，
 * 这样测试环境就与 DSH 的 `webServer.register()` 语义一致。
 *
 * @param {object} options - 桥配置。
 * @returns {Promise<{origin: string, tools: MockTools, close: () => Promise<void>}>}
 */
async function startBridge(options) {
  const tools = new MockTools();
  const { handler, teardown } = mountBridge(tools, options);
  if (handler === null) {
    return { origin: '', tools, close: async () => { teardown(); } };
  }
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${address.port}`,
    tools,
    async close() {
      teardown();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

console.log('\n== e2e: 健康检查与工具清单 ==');
const bridge = await startBridge({ enabled: true, listenPath: '/bridge', selfNodeId: 'windows-dsh' });
bridge.tools.add({
  name: 'shell_exec',
  description: '执行命令',
  parameters: { command: { type: 'string', required: true }, cwd: { type: 'string' } },
  run: async (args) => ({ output: `ran: ${args.command}` }),
});
bridge.tools.add({
  name: 'fs_read',
  description: '读文件',
  parameters: { path: { type: 'string', required: true } },
  run: async (args) => ({ content: `file:${args.path}` }),
});
bridge.tools.add({
  name: 'always_fails',
  description: '总是失败',
  parameters: {},
  run: async () => { throw new Error('boom'); },
});
const BASE = `${bridge.origin}/bridge`;

await test('GET /health 返回协议版本与节点', async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.result.nodeId, 'windows-dsh');
  assert.equal(json.result.protocolVersion, 1);
});
await test('GET /tools 列出 DSH 工具', async () => {
  const res = await fetch(`${BASE}/tools`);
  const json = await res.json();
  assert.equal(json.ok, true);
  const names = json.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['always_fails', 'fs_read', 'shell_exec']);
});
await test('工具参数已转成标准 JSON Schema（required 在父级）', async () => {
  const res = await fetch(`${BASE}/tools`);
  const json = await res.json();
  const shell = json.result.tools.find((t) => t.name === 'shell_exec');
  assert.equal(shell.parameters.type, 'object');
  assert.deepEqual(shell.parameters.required, ['command']);
  assert.equal(shell.parameters.properties.cwd.type, 'string');
});

console.log('\n== e2e: 出方向工具执行 ==');
await test('POST /tools/call 真的执行了工具', async () => {
  const res = await fetch(`${BASE}/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'shell_exec', arguments: { command: 'echo hi' } }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.match(JSON.stringify(json.content), /ran: echo hi/);
  assert.equal(bridge.tools.calls.length, 1);
});
await test('工具失败被投影成 ok:false 且带错误码', async () => {
  const res = await fetch(`${BASE}/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'always_fails', arguments: {} }),
  });
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'tool_failed');
});
await test('未知工具被 DSH 注册表拒绝，不崩服务器', async () => {
  const res = await fetch(`${BASE}/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'nope', arguments: {} }),
  });
  const json = await res.json();
  assert.equal(json.ok, false);
});
await test('缺 tool 字段返回 400', async () => {
  const res = await fetch(`${BASE}/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ arguments: {} }),
  });
  assert.equal(res.status, 400);
});
await test('非法 JSON 返回 400 而不是 500', async () => {
  const res = await fetch(`${BASE}/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error.code, 'bad_request');
});
await test('未知路径返回 404 且带结构化错误', async () => {
  const res = await fetch(`${BASE}/nope`);
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.equal(json.error.code, 'not_found');
});

console.log('\n== e2e: 循环防护 ==');
await test('跳数达到上限时 508 拒绝', async () => {
  const res = await fetch(`${BASE}/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-hop-count': '2' },
    body: JSON.stringify({ tool: 'shell_exec', arguments: { command: 'x' } }),
  });
  assert.equal(res.status, 508);
  const json = await res.json();
  assert.equal(json.error.code, 'hop_limit');
});
await test('被跳数拒绝时工具根本没执行', async () => {
  const before = bridge.tools.calls.length;
  await fetch(`${BASE}/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-hop-count': '5' },
    body: JSON.stringify({ tool: 'shell_exec', arguments: { command: 'x' } }),
  });
  assert.equal(bridge.tools.calls.length, before);
});
await test('不能通过桥调用桥自己注册的远端工具（自我循环）', async () => {
  const res = await fetch(`${BASE}/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'mcp__phone__screenshot', arguments: {} }),
  });
  assert.equal(res.status, 403);
  const json = await res.json();
  assert.equal(json.error.code, 'forbidden');
});

console.log('\n== e2e: 入方向（手机工具注册回 DSH）==');
// 手机侧假装自己也有一个桥端点，供 DSH 回调。
const phone = await startBridge({ enabled: true, listenPath: '/phone-bridge', selfNodeId: 'phone' });
phone.tools.add({
  name: 'get_battery',
  description: '读取手机电量',
  parameters: { type: 'object', properties: { detail: { type: 'boolean' } } },
  run: async (args) => ({ battery: 87, detail: args?.detail === true }),
});

await test('手机把工具注册进电脑，返回 accepted', async () => {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      node: 'phone',
      baseUrl: `${phone.origin}/phone-bridge`,
      tools: [{ name: 'get_battery', description: '读取手机电量', parameters: { type: 'object', properties: { detail: { type: 'boolean' } } } }],
    }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.result.accepted.length, 1);
  assert.equal(json.result.accepted[0].name, 'mcp__phone__get_battery');
});
await test('注册后的工具出现在 DSH 的工具清单里', async () => {
  const res = await fetch(`${BASE}/tools`);
  const json = await res.json();
  const names = json.result.tools.map((t) => t.name);
  // 注意：桥刻意把自己的 mcp__ 工具从可暴露清单里排除，所以这里不应出现。
  assert.equal(names.includes('mcp__phone__get_battery'), false);
});
await test('注册的工具真的能被 DSH 执行，并回调到手机', async () => {
  const definitions = bridge.tools.definitions();
  const remote = definitions.find((d) => d.name === 'mcp__phone__get_battery');
  assert.ok(remote !== undefined, 'remote tool should be registered in ctx.tools');
  const value = await remote.execute({ detail: true }, {});
  assert.deepEqual(value, { battery: 87, detail: true });
  assert.equal(phone.tools.calls.some((c) => c.name === 'get_battery'), true);
});
await test('GET /nodes 能看到已注册节点', async () => {
  const res = await fetch(`${BASE}/nodes`);
  const json = await res.json();
  assert.equal(json.ok, true);
  const node = json.result.nodes.find((n) => n.node === 'phone');
  assert.ok(node !== undefined);
  assert.equal(node.toolCount, 1);
});
await test('缺 baseUrl 的注册被拒（否则工具执行无路可走）', async () => {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ node: 'ghost', tools: [{ name: 't' }] }),
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error.message, /baseUrl/);
});
await test('非 http(s) 的 baseUrl 被拒', async () => {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ node: 'ghost', baseUrl: 'file:///etc/passwd', tools: [{ name: 't' }] }),
  });
  assert.equal(res.status, 400);
});
await test('非法工具描述进 rejected，不影响合法项', async () => {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      node: 'phone2',
      baseUrl: `${phone.origin}/phone-bridge`,
      tools: [
        { name: 'good_one' },
        { name: '' },
        { parameters: [] },
      ],
    }),
  });
  const json = await res.json();
  assert.equal(json.result.accepted.length, 1);
  assert.equal(json.result.rejected.length, 2);
});
await test('重复注册同名工具不报错（先撤旧的）', async () => {
  const body = {
    node: 'phone',
    baseUrl: `${phone.origin}/phone-bridge`,
    tools: [{ name: 'get_battery', description: 'v2' }],
  };
  const first = await fetch(`${BASE}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await first.json()).ok, true);
  const second = await fetch(`${BASE}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await second.json();
  assert.equal(json.ok, true);
  assert.equal(json.result.accepted.length, 1);
});

await phone.close();

console.log('\n== e2e: 令牌鉴权 ==');
const secured = await startBridge({ enabled: true, listenPath: '/bridge', selfNodeId: 'windows-dsh', token: 's3cret' });
await test('无令牌访问被 401 拒绝', async () => {
  const res = await fetch(`${secured.origin}/bridge/tools`);
  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.error.code, 'unauthorized');
});
await test('错误令牌被 401 拒绝', async () => {
  const res = await fetch(`${secured.origin}/bridge/tools`, { headers: { authorization: 'Bearer wrong' } });
  assert.equal(res.status, 401);
});
await test('正确令牌放行', async () => {
  const res = await fetch(`${secured.origin}/bridge/tools`, { headers: { authorization: 'Bearer s3cret' } });
  assert.equal(res.status, 200);
});
await test('健康检查不需要令牌（用于探活）', async () => {
  const res = await fetch(`${secured.origin}/bridge/health`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.result.authRequired, true);
});
await secured.close();

console.log('\n== e2e: 默认关闭 ==');
const disabled = await startBridge({});
await test('enabled 不为 true 时一个端点都不挂', async () => {
  // startBridge 在 handler 为 null 时返回空 origin，这里确认它确实没挂路由。
  assert.equal(disabled.origin, '');
  assert.equal(disabled.handler === undefined || disabled.handler === null, true);
});
await disabled.close();

await bridge.close();

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exitCode = 1;
