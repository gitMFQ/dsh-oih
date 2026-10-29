/**
 * 客户端设置页的渲染回归测试。
 *
 * 用最小 React/槽位替身把 lib/client.js 真正跑一遍：设置页空白过一次，
 * 原因是 Panel 里把 `useTranslate()` 返回的上下文当成 `t` 直接调用
 * （TypeError: t is not a function），被 settings.section 的错误边界吞掉后
 * 只留下一个空的 data-slot-error 占位。这里断言渲染树里确实出现了
 * 标题与表单文案，避免同类问题再次静默上线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ── 最小 React 替身 ────────────────────────────────────────────────

/** 每个组件函数一份 hook 状态，模拟真实 React 的组件实例。 */
const componentStates = new WeakMap();
let currentState = [];
let hookIndex = 0;
const contextStack = [];
const createdContexts = [];

function createContext(defaultValue) {
  const context = { defaultValue, Provider: Symbol('Context.Provider') };
  createdContexts.push(context);
  return context;
}

function useContext(context) {
  for (let i = contextStack.length - 1; i >= 0; i -= 1) {
    if (contextStack[i].context === context) return contextStack[i].value;
  }
  return context.defaultValue;
}

function useState(initial) {
  const slot = hookIndex;
  hookIndex += 1;
  if (!(slot in currentState)) currentState[slot] = typeof initial === 'function' ? initial() : initial;
  const setter = (next) => {
    currentState[slot] = typeof next === 'function' ? next(currentState[slot]) : next;
  };
  return [currentState[slot], setter];
}

function useEffect(fn) {
  hookIndex += 1;
  const cleanup = fn();
  if (typeof cleanup === 'function') cleanup();
}

const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }),
  createContext,
  useContext,
  useState,
  useEffect,
};

// ── 最小 DOM 替身（useStyles 会插入 <style>） ──────────────────────

globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', remove: () => {} }),
  head: { appendChild: () => {} },
};

// ── 渲染树展开 ─────────────────────────────────────────────────────

function render(node) {
  if (node === null || node === undefined || node === false) return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(render);

  const context = createdContexts.find((candidate) => candidate.Provider === node.type);
  if (context !== undefined) {
    contextStack.push({ context, value: node.props.value });
    const out = node.children.flatMap(render);
    contextStack.pop();
    return out;
  }

  if (typeof node.type === 'function') {
    const previousState = currentState;
    const previousIndex = hookIndex;
    if (!componentStates.has(node.type)) componentStates.set(node.type, []);
    currentState = componentStates.get(node.type);
    hookIndex = 0;
    try {
      return render(node.type({ ...node.props, children: node.children }));
    } finally {
      currentState = previousState;
      hookIndex = previousIndex;
    }
  }

  return node.children.flatMap(render);
}

// ── 加载插件客户端 ─────────────────────────────────────────────────

const dictionaries = new Map();
let sectionComponent;
/** 当前语言，模拟 locale 服务的 active 快照。 */
let activeLocale = 'zh';

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      globalThis.__openilinkClientModule = definition.factory((name) => {
        if (name === 'react') return React;
        throw new Error(`unexpected require: ${name}`);
      });
    },
  },
};

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ configured: false, state: 'unconfigured', hubUrl: '', sessions: [] }),
});

await import('../lib/client.js');

const clientModule = globalThis.__openilinkClientModule;

test('客户端模块导出 apply', () => {
  assert.equal(typeof clientModule?.apply, 'function');
  assert.deepEqual(clientModule.inject, ['slots', 'locale']);
});

test('apply 注册 settings.section，标签走 locale 字典', () => {
  const locale = {
    register(ns, dicts) {
      dictionaries.set(ns, dicts);
      return () => dictionaries.delete(ns);
    },
    bind: (ns) => (key) => dictionaries.get(ns)?.[activeLocale]?.[key] ?? key,
    getSnapshot: () => ({ active: activeLocale, revision: 0 }),
    subscribe: () => () => {},
  };

  const slots = {
    inject: (name, cb) => {
      assert.equal(name, 'settings.section');
      cb();
      return () => {};
    },
    register: (options, component) => {
      assert.equal(options.id, 'openilink');
      sectionComponent = component;
      return () => {};
    },
  };

  clientModule.apply({ effect: (fn) => fn(), locale, slots });

  assert.equal(typeof sectionComponent, 'function');
  assert.equal(dictionaries.get('openilink')?.zh?.['section.title'], 'OpeniLink 微信');
});

test('设置页渲染出标题与表单，而不是被错误边界吞成空白', () => {
  const text = render(React.createElement(sectionComponent, {})).join(' ');

  assert.match(text, /OpeniLink 微信/, '标题应出现在渲染树里');
  assert.match(text, /Hub 地址/, 'Hub 地址字段应渲染');
  assert.match(text, /App Token/, 'App Token 字段应渲染');
  assert.match(text, /保存并连接/, '保存按钮应渲染');
  assert.doesNotMatch(text, /^(section\.title|form\.)/, '不应退化成未翻译的 key');
});

test('切换语言后整块重渲染为英文文案', () => {
  // 与真实 locale 一致：bind 返回的函数按当前 active 取值。
  activeLocale = 'en';
  try {
    const text = render(React.createElement(sectionComponent, {})).join(' ');
    assert.match(text, /OpeniLink WeChat/);
    assert.match(text, /Hub URL/);
    assert.match(text, /Save and connect/);
    assert.doesNotMatch(text, /保存并连接/, '不应残留中文');
  } finally {
    activeLocale = 'zh';
  }
});
