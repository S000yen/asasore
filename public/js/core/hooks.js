// 描画を呼び出すための「つなぎ」。通信などが、描画（app/render.js）を直接 import しなくて済むようにする。
// 起動時に、main.js が setRenderer(render) で登録する。

let renderFn = () => {};

export const setRenderer = (fn) => { renderFn = fn; };

export const requestRender = () => renderFn();
