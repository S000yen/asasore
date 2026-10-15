// 状態から決まる、画面の判断。

import { state, ui } from './state.js';

// 主催者の「まとめを編集」中か。編集中は、完了するまで他の操作ができない。
export const canEditGroups = () => Boolean(state.view?.me.isHost && ['reveal', 'vote'].includes(state.view.phase) && state.view.pool.filter((c) => c.revealed).length >= 2);
export const isEditing = () => ui.editing && canEditGroups();
