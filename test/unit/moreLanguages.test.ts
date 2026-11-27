import * as assert from 'assert';
import { EXT_LANGUAGE } from '../../src/detection/languages';
import { maskText } from '../../src/detection/mask';
import { detect, lines, outline } from './helpers';
import {
  DART_SAMPLE,
  ELIXIR_SAMPLE,
  HASKELL_SAMPLE,
  LUA_SAMPLE,
  POWERSHELL_SAMPLE,
  R_SAMPLE,
  SCALA_SAMPLE,
  ZIG_SAMPLE,
} from './moreLanguageSamples';

const crlf = (t: string) => t.replace(/\n/g, '\r\n');

/** LF 與 CRLF 的結果都要和預期相同，且規則沒有編譯錯誤。 */
function check(sample: string, languageId: string, want: object): void {
  const r = detect(sample, languageId);
  assert.deepStrictEqual(r.errors, [], `${languageId} 規則錯誤`);
  assert.deepStrictEqual(outline(r.symbols), want, languageId);
  assert.deepStrictEqual(outline(detect(crlf(sample), languageId).symbols), want, `${languageId}（CRLF）`);
}

describe('Lua、Dart、Scala、Elixir、PowerShell、R、Haskell、Zig', () => {
  it('Lua：function、local function、M.x、M:x、x = function；字串、長字串、區塊註解裡的 end 不影響範圍', () => {
    check(LUA_SAMPLE, 'lua', {
      'function helper@3-7': {},
      'function M.greet@9-14': {},
      'method M:save@16-19': {},
      'function M.handler@21-23': {},
      'function short@25-25': {},
    });
  });

  it('Dart：函式、類別方法、建構子（含沒有本體的 const 建構子）、factory、getter／setter、=> 本體；呼叫、只有宣告的方法、字串內插裡的 { } 都不算', () => {
    check(DART_SAMPLE, 'dart', {
      'function main@3-5': {},
      'class MyApp@7-26': {
        'method MyApp@8-8': {},
        'method build@11-15': {},
        'method count@17-17': {},
        'method count@19-21': {},
        'method load@23-25': {},
      },
      'class Point@28-37': { 'method Point@30-34': {}, 'method Point.origin@35-35': {} },
      'class Logger@39-41': { 'method log@40-40': {} },
      'function greet@43-43': {},
    });
  });

  it('Scala：大括號與 Scala 3 縮排寫法（含 end 標記）、extends 寫在下一行、單行 def、抽象 def、頂層 def', () => {
    check(SCALA_SAMPLE, 'scala', {
      'class Main@3-9': { 'method main@4-6': {}, 'method add@8-8': {} },
      'class Shape@11-16': { 'method area@12-12': {}, 'method describe@13-15': {} },
      'class Circle@18-19': { 'method area@19-19': {} },
      'class Box@21-27': { 'method get@23-23': {}, 'method check@24-26': {} },
      'function topLevel@29-32': {},
    });
  });

  it('Elixir：多段 def 合併成一個；do: 單行寫法不吃到外層的 end；heredoc、內插、sigil、?" 字元不影響；ExUnit 的 describe／test', () => {
    check(ELIXIR_SAMPLE, 'elixir', {
      'class MyApp.Math@0-22': {
        'function fact@6-11': {},
        'function helper@13-19': {},
        'function valid?@21-21': {},
      },
      'class MyApp.MathTest@24-32': { 'block fact/1@27-31': { 'block of zero@28-30': {} } },
    });
  });

  it('PowerShell：function（大小寫不拘、範圍修飾、大括號在下一行）、class 的建構子與方法、enum；註解、字串、here-string 裡的 { } 不影響', () => {
    check(POWERSHELL_SAMPLE, 'powershell', {
      'function Get-Thing@3-10': {},
      'function Set-Thing@12-18': {},
      'class Person@20-30': { 'method Person@22-24': {}, 'method Greet@25-28': {}, 'method Count@29-29': {} },
      'class Color@32-32': {},
    });
  });

  it('R：<-、=、反引號名稱、運算式本體、\\(x) 簡寫、大括號在下一行、R6 類別的方法；字串與原始字串裡的 } 不影響', () => {
    check(R_SAMPLE, 'r', {
      'function add@1-5': {},
      'function square@7-7': {},
      'function `%||%`@9-9': {},
      'function outer@11-15': { 'function inner@13-13': {} },
      'class Person@17-27': { 'method initialize@20-22': {}, 'method greet@23-25': {} },
    });
  });

  it('Haskell：型別簽名與各段等式合併、guard 與 where、data／class／instance；註解與名稱裡的 \' 不影響', () => {
    check(HASKELL_SAMPLE, 'haskell', {
      'class Shape@5-6': {},
      'class Describe@8-10': { 'method describe@9-10': {} },
      'class Describe Shape@12-14': { 'method describe@13-14': {} },
      'function area@16-18': {},
      'function classify@20-26': {},
      "function foldl'@28-29": {},
      'function main@32-35': {},
    });
  });

  it('Haskell：Template Haskell 的頂層呼叫不是函式；--> 是運算子不是註解；不同名稱不合併', () => {
    const t = lines("makeLenses ''Config", 'infixr 5 -->', 'first = 1', 'second = 2');
    assert.deepStrictEqual(outline(detect(t, 'haskell').symbols), {
      'function first@2-2': {},
      'function second@3-3': {},
    });
    assert.strictEqual(maskText('x = a --> b -- note', 'haskell'), 'x = a --> b        ');
    assert.strictEqual(maskText("c = 'x' ++ foldl' f", 'haskell'), "c = ' ' ++ foldl' f");
  });

  it('Zig：struct／enum 與其中的方法、error{…} 回傳型別、\\\\ 多行字串、extern fn、test 區塊', () => {
    check(ZIG_SAMPLE, 'zig', {
      'class Point@3-13': { 'method init@6-8': {}, 'method check@10-12': {} },
      'class Color@15-15': {},
      'function main@17-25': {},
      'function puts@27-27': {},
      'block point init@29-31': {},
    });
  });

  it('字串內插一直沒有閉合時（"#{"、\'${\'、"$("）不會遞迴到堆疊用完', () => {
    for (const [lang, line] of [
      ['elixir', '  x = "#{"'],
      ['dart', "  var x = '${'"],
      ['powershell', '  $x = "$("'],
    ]) {
      const text = Array.from({ length: 3000 }, () => line).join('\n');
      assert.doesNotThrow(() => maskText(text, lang as 'elixir' | 'dart' | 'powershell'), lang);
    }
  });

  it('副檔名對到語言（沒有裝語言擴充、檔案是純文字時也能偵測）', () => {
    const want: Record<string, string> = {
      '.lua': 'lua',
      '.dart': 'dart',
      '.scala': 'scala',
      '.sc': 'scala',
      '.ex': 'elixir',
      '.exs': 'elixir',
      '.ps1': 'powershell',
      '.psm1': 'powershell',
      '.r': 'r',
      '.hs': 'haskell',
      '.zig': 'zig',
    };
    for (const [ext, lang] of Object.entries(want)) {
      assert.strictEqual(EXT_LANGUAGE[ext], lang, ext);
    }
  });
});
