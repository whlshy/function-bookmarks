import { DetectionRule } from '../types';
import { LanguageDef } from './define';
import { GENERIC, PARAMS } from './fragments';

const D_KW =
  'if|else|for|while|do|switch|case|return|new|throw|try|catch|finally|assert|await|yield|import|export|part|library|var|final|const|late|is|as|in|rethrow|super|this|with|implements|extends|on|show|hide|typedef|operator|get|set|factory|static|external|abstract|covariant|required';
const D_ID = String.raw`[A-Za-z_$][\w$]*`;
/** 型別：void、int?、Future<void>、Map<String, dynamic>、prefix.Type。 */
const D_TYPE = String.raw`(?!(?:${D_KW})\b)${D_ID}(?:\.${D_ID})?(?:${GENERIC})?\??`;
/** 同一行的 @annotation（通常在上一行，那樣不影響比對）。 */
const D_ANN = String.raw`(?:@[A-Za-z_$][\w$.]*(?:\([^)\n]*\))?[ \t]+)*`;
const D_MOD = String.raw`(?:(?:static|external|abstract)[ \t]+)*`;
/** 參數之後是本體：{ 或 =>（可先有 async、async*、sync*）。只有宣告（以 ; 結尾）的不列。 */
const D_BODY = String.raw`(?=[ \t]*(?:async\*?|sync\*)?[ \t\r\n]*(?:\{|=>))`;
const D_FUNC = String.raw`^[ \t]*${D_ANN}${D_MOD}${D_TYPE}[ \t]+(?!(?:${D_KW})\b)(?<name>${D_ID})[ \t]*(?:${GENERIC})?${PARAMS}${D_BODY}`;

const rules: DetectionRule[] = [
  // ---------- Dart ----------
  {
    id: 'dart-type',
    label: 'class／mixin／enum／extension Xxx',
    languages: ['dart'],
    pattern: String.raw`^[ \t]*${D_ANN}(?:(?:abstract|base|final|interface|sealed|mixin)[ \t]+)*(?:class|mixin|enum|extension(?:[ \t]+type)?)[ \t]+(?!on\b)(?<name>${D_ID})`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'dart-ctor',
    // 建構子常常沒有本體（const Xxx({super.key}) : …;），所以 ; 結尾的也列；只在 class 裡算，不會把呼叫當成建構子
    label: 'class 內的建構子 Xxx()／Xxx.named()／factory Xxx()',
    languages: ['dart'],
    pattern: String.raw`^[ \t]*${D_ANN}(?:(?:const|factory|external)[ \t]+)*(?<name>_*[A-Z][\w$]*(?:\.${D_ID})?)[ \t]*${PARAMS}(?=[ \t\r\n]*(?:async[ \t]*)?(?::[^;{]*?)?(?:\{|=>|;|=))`,
    kind: 'method',
    body: 'brace',
    within: ['class'],
  },
  {
    id: 'dart-getter',
    label: 'get xxx => …',
    languages: ['dart'],
    pattern: String.raw`^[ \t]*${D_ANN}${D_MOD}(?:${D_TYPE}[ \t]+)?get[ \t]+(?<name>${D_ID})${D_BODY}`,
    kind: 'method',
    body: 'brace',
  },
  {
    id: 'dart-setter',
    label: 'set xxx(v) {}',
    languages: ['dart'],
    pattern: String.raw`^[ \t]*${D_ANN}${D_MOD}(?:${D_TYPE}[ \t]+)?set[ \t]+(?<name>${D_ID})[ \t]*${PARAMS}${D_BODY}`,
    kind: 'method',
    body: 'brace',
  },
  {
    id: 'dart-method',
    label: 'class 內的 Type xxx() {}／=> …',
    languages: ['dart'],
    pattern: D_FUNC,
    kind: 'method',
    body: 'brace',
    within: ['class'],
  },
  {
    id: 'dart-function',
    label: 'Type xxx() {}／=> …',
    languages: ['dart'],
    pattern: D_FUNC,
    kind: 'function',
    body: 'brace',
  },
];

export const dart: LanguageDef = {
  syntax: { dart: 'dart' },
  extensions: { '.dart': 'dart' },
  projectExtensions: ['dart'],
  rules,
};
