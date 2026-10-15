// 回答：お題を見て、答えを書く。

import { drafts, state } from '../../core/state.js';
import { esc } from '../../lib/format.js';
import { progress } from '../components/progress.js';
import { telop } from '../components/telop.js';
import { timerHtml } from '../components/timer.js';

export function answerHtml() {
  const v = state.view;
  const box = v.me.spectator ? '' : `
    <div class="answerbox">
      <textarea id="answerInput" data-draft="answer" rows="3" maxlength="100" placeholder="答えを入力" ${v.myAnswer !== null ? 'readonly' : ''}>${esc(drafts.answer)}</textarea>
      <div class="box-actions">${v.myAnswer !== null ? '<button class="btn small" data-do="withdraw">取り下げる</button>' : '<button class="btn primary small" data-do="submitAnswer">回答する</button>'}</div>
    </div>`;
  return `
    ${telop(v.topic)}${box}
    ${progress('回答状況', v.players.filter((p) => !p.spectator), (p) => p.answered, timerHtml())}`;
}
