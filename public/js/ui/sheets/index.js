// 下から出るシート。種類（ui.sheet.kind）ごとの中身を、外枠で包む。

import { state, ui } from '../../core/state.js';
import { historySheet } from './history.js';
import { howtoSheet } from './howto.js';
import { menuSheet } from './menu.js';
import { allowSheet, chooserSheet, presenterSheet, transferSheet } from './pickers.js';
import { playersSheet } from './players.js';
import { renameSheet } from './rename.js';
import { settingsSheet } from './settings.js';

const SHEETS = { menu: menuSheet, history: historySheet, rename: renameSheet, settings: settingsSheet, transfer: transferSheet, howto: howtoSheet, players: playersSheet, allow: allowSheet, chooser: chooserSheet, presenter: presenterSheet };

export function sheetHtml() {
  if (!ui.sheet) return '';
  const inner = Object.hasOwn(SHEETS, ui.sheet.kind) ? SHEETS[ui.sheet.kind](state.view) : '';
  return `<div class="scrim" data-do="scrim"><div class="sheet"><button class="x" data-do="closeSheet" aria-label="閉じる">×</button>${inner}</div></div>`;
}
