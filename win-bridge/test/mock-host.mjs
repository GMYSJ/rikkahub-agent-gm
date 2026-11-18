/**
 * 测试用的最小 DSH 宿主替身。
 *
 * 让 `lib/index.js` 可以**原样**跑起来，不需要真的启动 DSH：
 *  - `MockTools` 复刻 `ctx.tools` 在插件里用到的三个能力：
 *    `definitions()` / `register()` / `execute()`；
 *  - `mountBridge()` 复刻 `ctx.webServer.register()` 的分发语义
 *    （prefix 路由、按 pathname 剥前缀）。
 *
 * 关键取舍：替身只实现**插件真正调用的**那部分，其余一律不做。
 * 这样测试一旦通过，就说明插件没有偷偷依赖未声明的宿主能力。
 *
 * @module test/mock-host
 */

import { apply, name as PLUGIN_NAME, inject as PLUGIN_INJECT } from '../lib/index.js';

/**
 * 模拟 `ctx.tools`。
 *
 * `execute()` 刻意用**失败结果**（而不是抛异常）表达「工具不存在」，
 * 与真实 DSH 的 ToolExecutionFailure 语义保持一致。
 */
export class MockTools {
  constructor() {
    /** @type {Map<string, {definition: object, run: Function}>} */
    this.registry = new Map();
    /** @type {Array<{name: string, args: unknown}>} */
    this.calls = [];
  }

  /**
   * 注册一个工具定义（对应真实 DSH 的 `ctx.tools.register`）。
   *
   * @param {object} definition - `defineTool()` 的产出，至少含 `name` 与 `execute`。
   * @returns {() => void} disposer。
   */
  register(definition) {
    if (definition === null || typeof definition !== 'object') {
      throw new TypeError('tool definition must be an object');
    }
    const toolName = definition.name;
    if (typeof toolName !== 'string' || toolName === '') {
      throw new TypeError('tool definition requires a name');
    }
    if (typeof definition.execute !== 'function') {
      throw new TypeError(`tool "${toolName}" requires an execute function`);
    }
    if (this.registry.has(toolName)) {
      throw new Error(`tool "${toolName}" is already registered`);
    }
    this.registry.set(toolName, { definition, run: definition.execute });
    return () => {
      this.registry.delete(toolName);
    };
  }

  /**
   * 取当前可见定义，模仿 `ctx.tools.definitions()`。
   *
   * @returns {readonly object[]}
   */
  definitions() {
    return [...this.registry.values()].map((entry) => entry.definition);
  }

  /**
   * 模仿 `ctx.tools.execute({ calls, signal })`。
   *
   * @param {{calls: Array<{type: string, id: string, name: string, arguments: string}>, signal: AbortSignal}} input - 批次。
   * @returns {Promise<{results: Array<{callId: string, result: object}>, additionalContexts: object[], concluded: boolean}>}
   */
  async execute(input) {
    const results = [];
    for (const call of input.calls ?? []) {
      const entry = this.registry.get(call.name);
      if (entry === undefined) {
        results.push({
          callId: call.id,
          result: {
            isError: true,
            error: { code: 'unknown_tool', message: `unknown tool: ${call.name}` },
            content: [{ type: 'text', text: `unknown tool: ${call.name}` }],
          },
        });
        continue;
      }
      let args;
      try {
        args = JSON.parse(call.arguments ?? '{}');
      } catch {
        args = {};
      }
      this.calls.push({ name: call.name, args });
      try {
        const value = await entry.run(args, { signal: input.signal });
        results.push({
          callId: call.id,
          result: {
            isError: false,
            value: value ?? null,
            content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          callId: call.id,
          result: {
            isError: true,
            error: { code: 'tool_failed', message },
            content: [{ type: 'text', text: message }],
          },
        });
      }
    }
    return { results, additionalContexts: [], concluded: false };
  }

  /**
   * 测试便利：用紧凑写法注册一个「普通工具」。
   *
   * @param {{name: string, description?: string, parameters?: object, run: (args: any) => unknown | Promise<unknown>}} spec - 工具规格。
   * @returns {() => void} disposer。
   */
  add(spec) {
    return this.register({
      name: spec.name,
      description: spec.description ?? '',
      parameters: spec.parameters ?? {},
      output: { schema: { type: 'json' }, render: () => [] },
      execute: spec.run,
    });
  }
}

/**
 * 造一个够用的 `defineTool` 替身并注入。
 *
 * 真实 `defineTool` 会校验 schema；替身只做恒等 + 基本断言，
 * 因为桥的测试关注的是协议与流程，schema 校验另有 smoke 覆盖。
 *
 * @param {object} definition - 工具定义。
 * @returns {object} 原样返回。
 */
function passthroughDefineTool(definition) {
  if (definition === null || typeof definition !== 'object') {
    throw new TypeError('defineTool requires an object');
  }
  if (typeof definition.name !== 'string' || definition.name === '') {
    throw new TypeError('defineTool requires a name');
  }
  if (typeof definition.execute !== 'function') {
    throw new TypeError('defineTool requires execute');
  }
  if (definition.output === undefined) {
    throw new TypeError('defineTool requires output { schema, render }');
  }
  return definition;
}

/**
 * 把桥挂到假的宿主上。
 *
 * @param {MockTools} tools - 假工具注册表。
 * @param {object} config - 传给 `apply()` 的配置。
 * @returns {{handler: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>) | null, mounted: Array<{kind: string, path: string}>, teardown: () => void, plugin: {name: string, inject: string[]}}}
 */
export function mountBridge(tools, config) {
  /** @type {Array<{kind: string, path: string, handler: Function}>} */
  const routes = [];
  /** @type {Array<() => void>} */
  const effects = [];
  let teardownFn = null;

  const ctx = {
    tools,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    webServer: {
      /**
       * @param {{kind: string, path: string, handler: Function}} route - 路由。
       * @returns {() => void} disposer。
       */
      register(route) {
        if (routes.some((r) => r.path === route.path)) {
          throw new Error(`duplicate route path: ${route.path}`);
        }
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    /**
     * @param {() => () => void} fn - 卸载回调工厂。
     */
    effect(fn) {
      const dispose = fn();
      effects.push(dispose);
      teardownFn = () => {
        for (const d of effects.splice(0)) {
          try {
            if (typeof d === 'function') d();
          } catch {
            /* ignore */
          }
        }
      };
    },
  };

  apply(ctx, config);

  if (routes.length === 0) {
    return {
      handler: null,
      mounted: [],
      teardown: () => {},
      plugin: { name: PLUGIN_NAME, inject: PLUGIN_INJECT },
    };
  }

  const route = routes[0];
  /**
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   */
  const handler = async (req, res) => {
    try {
      await route.handler(req, res);
    } catch (err) {
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(err) } }));
      }
    }
  };

  return {
    handler,
    mounted: routes.map((r) => ({ kind: r.kind, path: r.path })),
    teardown: () => {
      if (teardownFn !== null) teardownFn();
    },
    plugin: { name: PLUGIN_NAME, inject: PLUGIN_INJECT },
  };
}

/**
 * 供测试断言：插件声明了正确的注入依赖。
 *
 * @returns {{name: string, inject: string[]}}
 */
export function pluginIdentity() {
  return { name: PLUGIN_NAME, inject: PLUGIN_INJECT };
}

export { passthroughDefineTool };
