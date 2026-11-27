import { Syntax } from '../types';
import { syntaxForLanguage } from '../languages';
import { C_FAMILY, maskCFamily } from './cFamily';
import { maskDart } from './dart';
import { maskElixir } from './elixir';
import { maskHaskell } from './haskell';
import { maskJs } from './js';
import { maskLua } from './lua';
import { maskMarkdown } from './markdown';
import { maskPhp } from './php';
import { maskPowerShell } from './powershell';
import { maskPython } from './python';
import { maskR } from './r';
import { maskRuby } from './ruby';
import { maskShell } from './shell';
import { maskSql } from './sql';
import { maskSfc } from './sfc';
import { maskTemplate } from './template';
import { maskZig } from './zig';

export { syntaxForLanguage };

/**
 * 把註解與字串內容換成空白（換行保留），長度與原文相同，
 * 讓規則比對與括號配對不會被註解、字串裡的文字干擾。
 */
export function maskText(text: string, syntax: Syntax): string {
  // 檔案開頭的 BOM 當成空白（長度不變），第一行的 # 標題、def 才比對得到
  if (text.charCodeAt(0) === 0xfeff) {
    return maskText(` ${text.slice(1)}`, syntax);
  }
  switch (syntax) {
    case 'c':
      return maskJs(text, false);
    case 'jsx':
      return maskJs(text, true);
    case 'python':
      return maskPython(text);
    case 'template':
      return maskTemplate(text);
    case 'markdown':
      return maskMarkdown(text);
    case 'ruby':
      return maskRuby(text);
    case 'php':
      return maskPhp(text);
    case 'shell':
      return maskShell(text);
    case 'sql':
      return maskSql(text);
    case 'sfc':
      return maskSfc(text);
    case 'dart':
      return maskDart(text);
    case 'lua':
      return maskLua(text);
    case 'elixir':
      return maskElixir(text);
    case 'powershell':
      return maskPowerShell(text);
    case 'r':
      return maskR(text);
    case 'haskell':
      return maskHaskell(text);
    case 'zig':
      return maskZig(text);
    default: {
      const family = C_FAMILY[syntax];
      return family ? maskCFamily(text, family) : text;
    }
  }
}
