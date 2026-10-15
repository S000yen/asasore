// 画面の HTML を作る関数（entryHtml / roomHtml）を、ブラウザなしで動かして、HTML の文字列を返す。
//
// 画面を作る部分（public/js/ui/）は、状態（core/state.js）を読んで文字列を返すだけの関数で、読み込んだだけでは DOM に触らない。
// なので、状態に値を入れて、そのまま呼ぶだけでよい。（以前は、1枚のスクリプトを vm で動かしていた）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const HOWTO = fs.readFileSync(path.join(ROOT, 'public', 'howto.md'), 'utf8');
const load = (rel) => import(pathToFileURL(path.join(ROOT, 'public', 'js', rel)).href);

const { state, ui, drafts, newRoom, resetState } = await load('core/state.js');
const { entryHtml } = await load('ui/pages/entry.js');
const { roomHtml } = await load('ui/pages/room.js');
const { mdToHtml } = await load('lib/format.js');
const { resetRoster } = await load('effects/roster.js');

const FUNCTIONS = { entryHtml, roomHtml };

// 参加者の跳ねる位置などに使われる乱数を、いつも同じ並びにする
function seededRandom() {
  let s = 12345;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// シナリオ1つぶんの HTML を返す。
//   sc = { fn: 'roomHtml' | 'entryHtml', view: ビューの名前, viewPatch: ビューの一部を書き換える, ui, drafts, state: { session, endMessage, prefName }, newRoom, howto }
//   views = { 名前: サーバーが送るビュー }
export function renderScenario(sc, views) {
  const render = FUNCTIONS[sc.fn];
  if (!render) throw new Error(`知らない関数です: ${sc.fn}`);
  const base = sc.view ? views[sc.view] : null;
  if (sc.view && !base) throw new Error(`ビューがありません: ${sc.view}`);

  resetState();
  resetRoster();
  state.view = base && sc.viewPatch ? { ...base, ...sc.viewPatch } : base;
  state.session = sc.state?.session ?? null;
  state.endMessage = sc.state?.endMessage ?? null;
  state.prefName = sc.state?.prefName ?? '';
  Object.assign(ui, sc.ui ?? {});
  ui.sel = new Set(sc.ui?.sel ?? []);
  Object.assign(drafts, sc.drafts ?? {});
  Object.assign(newRoom, sc.newRoom ?? {});
  if (sc.howto) state.howtoHtml = mdToHtml(HOWTO);

  // 乱数と、経過時間の基準（performance.now）を、呼ぶあいだだけ固定する
  const realRandom = Math.random;
  const realPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  Math.random = seededRandom();
  Object.defineProperty(globalThis, 'performance', { value: { now: () => 0 }, configurable: true, writable: true });
  try {
    return render();
  } finally {
    Math.random = realRandom;
    Object.defineProperty(globalThis, 'performance', realPerformance);
  }
}
