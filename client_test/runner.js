// 画面の HTML を作る関数を、ブラウザなしで動かして、HTML の文字列を取り出す。
//
// いまの public/js/app/main.js は、グローバルな状態を直接読み書きする1枚のスクリプトなので、
// Node の vm に、DOM の代わりになる最小限の偽物を渡して読み込み、状態を代入してから entryHtml() / roomHtml() を呼ぶ。
// （画面を module に分けたあとは、この中身を、新しい views を import する形に差し替える。シナリオと golden は、そのまま使う。）

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app', 'main.js'), 'utf8');
const HOWTO = fs.readFileSync(path.join(ROOT, 'public', 'howto.md'), 'utf8');
const script = new vm.Script(SOURCE, { filename: 'public/js/app/main.js' });

const noop = () => {};

// DOM の代わり。main.js が読み込み時に触るものだけを、何もしない形で用意する。
function makeSandbox() {
  const element = () => ({
    addEventListener: noop,
    childNodes: [],
    innerHTML: '',
    style: {},
    dataset: {},
    classList: { add: noop, remove: noop, toggle: noop },
    append: noop,
    remove: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const app = element();
  const document = {
    getElementById: (id) => (id === 'app' ? app : null),
    addEventListener: noop,
    createElement: element,
    querySelector: () => null,
    body: element(),
    hidden: false,
  };
  class WebSocket { constructor() { this.readyState = 0; } send() {} close() {} }
  return {
    document,
    window: { addEventListener: noop, innerWidth: 390, innerHeight: 800, devicePixelRatio: 1 },
    WebSocket,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { search: '', protocol: 'http:', host: 'localhost', pathname: '/', origin: 'http://localhost' },
    history: { replaceState: noop },
    navigator: {},
    crypto: { randomUUID: () => 'test-uuid' },
    performance: { now: () => 0 }, // 経過時間の表示を、いつも同じにする
    URLSearchParams,
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: noop,
    fetch: () => new Promise(noop),
    console,
  };
}

// 参加者の跳ねる位置などに使われる乱数を、いつも同じ並びにする
const SEED_RANDOM = 'Math.random = (() => { let s = 12345; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();';

const j = (v) => JSON.stringify(v ?? null);

// シナリオ1つぶんの HTML を返す。
//   sc = { fn: 'roomHtml' | 'entryHtml', view: ビューの名前, viewPatch: ビューの一部を書き換える, ui, drafts, state: { session, endMessage, prefName }, newRoom, howto }
//   views = { 名前: サーバーが送るビュー }
export function renderScenario(sc, views) {
  const ctx = vm.createContext(makeSandbox());
  vm.runInContext(SEED_RANDOM, ctx);
  script.runInContext(ctx);
  const base = sc.view ? views[sc.view] : null;
  if (sc.view && !base) throw new Error(`ビューがありません: ${sc.view}`);
  const view = base && sc.viewPatch ? { ...base, ...sc.viewPatch } : base;
  return vm.runInContext(`
    view = ${j(view)};
    session = ${j(sc.state?.session)};
    endMessage = ${j(sc.state?.endMessage)};
    prefName = ${j(sc.state?.prefName ?? '')};
    Object.assign(ui, ${j(sc.ui ?? {})});
    ui.sel = new Set(${j(sc.ui?.sel ?? [])});
    Object.assign(drafts, ${j(sc.drafts ?? {})});
    Object.assign(newRoom, ${j(sc.newRoom ?? {})});
    ${sc.howto ? `howtoHtml = mdToHtml(${j(HOWTO)});` : ''}
    ${sc.fn}();
  `, ctx);
}
