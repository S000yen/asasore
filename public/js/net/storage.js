// 端末への保存（localStorage）：参加中の部屋、自分で付けた表示名、この端末の匿名ID。

const STORE = 'asaso.session';
const CLIENT_STORE = 'asaso.client'; // この端末の匿名ID。「おかしい」の報告を、端末ごとに1回と数えるために使う
const NAME_STORE = 'asaso.name'; // 自分で付けた表示名（次の部屋でも使う）。未設定なら、部屋ごとに「ユーザーN」になる

export const loadSession = () => {
  try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; }
};
export const saveSession = (s) => {
  try { s ? localStorage.setItem(STORE, JSON.stringify(s)) : localStorage.removeItem(STORE); } catch { /* 保存できなくても動く */ }
};
export const loadName = () => {
  try { return localStorage.getItem(NAME_STORE) ?? ''; } catch { return ''; }
};
export const saveName = (n) => {
  try { localStorage.setItem(NAME_STORE, n); } catch { /* 保存できなくても動く */ }
};

export const clientId = (() => {
  try {
    let id = localStorage.getItem(CLIENT_STORE);
    if (!id) {
      id = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(CLIENT_STORE, id);
    }
    return id;
  } catch { return null; } // 保存できない端末では、IDなし（サーバー側で参加者ごとに数える）
})();
