// セーブ/ロード: localStorage自動保存 + JSONファイルの書き出し/読み込み

import { SAVE_KEY } from './config';
import { Game } from './sim';
import type { SaveData } from './sim';

export function saveToLocal(game: Game): boolean {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(game.serialize()));
    return true;
  } catch {
    return false;
  }
}

export function loadFromLocal(game: Game): boolean {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    return game.loadFrom(JSON.parse(raw) as SaveData);
  } catch {
    return false;
  }
}

export function clearLocal() {
  localStorage.removeItem(SAVE_KEY);
}

export function exportFile(game: Game) {
  const blob = new Blob([JSON.stringify(game.serialize(), null, 1)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `semifab-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function importFile(game: Game, onDone: (ok: boolean) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return onDone(false);
    file.text().then((text) => {
      try {
        onDone(game.loadFrom(JSON.parse(text) as SaveData));
      } catch {
        onDone(false);
      }
    });
  });
  input.click();
}
