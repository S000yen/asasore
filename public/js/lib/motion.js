// 動きを減らす設定（prefers-reduced-motion）の判定。

export const prefersReducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
