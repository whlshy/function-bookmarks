/**
 * 共用核心：讀取 .vscode/settings.json（允許註解與結尾逗號）成為設定讀取函式。
 * CLI 在編輯器外使用；套件內改用 VS Code 的設定 API（會合併使用者、工作區等各層設定）。
 */
import { stripBom } from '../util/bom';
import { ConfigReader, SECTION } from './settings';

/** 從 i 開始略過空白與註解，回傳下一個有意義字元的位置。 */
function skipTrivia(text: string, i: number): number {
  const n = text.length;
  while (i < n) {
    if (/\s/.test(text[i])) {
      i++;
    } else if (text[i] === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') {
        i++;
      }
    } else if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      break;
    }
  }
  return i;
}

/** 去掉 JSON with Comments 的註解與結尾逗號（字串裡的內容不動，例如正規表示式的 `{3,}`），再交給 JSON.parse。 */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      // 整個字串原樣保留（含跳脫字元）
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        j += text[j] === '\\' ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const next = skipTrivia(text, i);
      out += text.slice(i, next).includes('\n') ? '\n' : ' ';
      i = next;
    } else if (c === ',' && (text[skipTrivia(text, i + 1)] === '}' || text[skipTrivia(text, i + 1)] === ']')) {
      // 結尾逗號：後面（略過空白與註解）直接接 } 或 ]
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** 解析 settings.json；內容壞掉或不是物件時回傳 undefined。 */
export function parseSettingsJson(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(stripJsonc(stripBom(text)));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把 settings.json 的內容變成 functionBookmarks 的設定讀取函式。
 * 支援常見的平鋪寫法（"functionBookmarks.detection.rules": …），也支援巢狀物件（"functionBookmarks": { "detection": { … } }）。
 */
export function readerFromSettings(settings: Record<string, unknown> | undefined): ConfigReader {
  return <T>(key: string, fallback: T): T => {
    if (!settings) {
      return fallback;
    }
    const flat = `${SECTION}.${key}`;
    if (Object.prototype.hasOwnProperty.call(settings, flat)) {
      return settings[flat] as T;
    }
    let cur: unknown = settings;
    for (const part of flat.split('.')) {
      if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) {
        return fallback;
      }
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur as T;
  };
}
