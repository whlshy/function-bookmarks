import { DetectionRule, Syntax } from '../types';
import { cCpp } from './cCpp';
import { csharp } from './csharp';
import { dart } from './dart';
import { LanguageDef } from './define';
import { django } from './django';
import { elixir } from './elixir';
import { go } from './go';
import { haskell } from './haskell';
import { java } from './java';
import { javascript } from './javascript';
import { kotlin } from './kotlin';
import { lua } from './lua';
import { markdown } from './markdown';
import { php } from './php';
import { powershell } from './powershell';
import { proto } from './proto';
import { python } from './python';
import { r } from './r';
import { ruby } from './ruby';
import { rust } from './rust';
import { scala } from './scala';
import { shell } from './shell';
import { sql } from './sql';
import { swift } from './swift';
import { vueSvelte } from './vueSvelte';
import { zig } from './zig';

export { TEMPLATE_FILES_PLACEHOLDER } from './fragments';
export { LanguageDef } from './define';

/**
 * 所有內建語言。順序就是內建規則的順序（同一個名稱被多條規則抓到時，排在前面的優先）。
 * 每條規則都有對應的測試範例（test/unit/builtinRules.test.ts）。
 */
export const LANGUAGES: LanguageDef[] = [javascript, python, cCpp, rust, go, java, csharp, kotlin, swift, php, ruby, markdown, django, proto, vueSvelte, shell, sql, lua, dart, scala, elixir, powershell, r, haskell, zig];

export const BUILTIN_RULES: DetectionRule[] = LANGUAGES.flatMap((l) => l.rules);

/** 副檔名（小寫、含點）→ 語言 ID。 */
export const EXT_LANGUAGE: Record<string, string> = Object.assign({}, ...LANGUAGES.map((l) => l.extensions));

/** 「整個專案」預設列出的副檔名（不含點）。 */
export const PROJECT_EXTENSIONS: string[] = LANGUAGES.flatMap((l) => l.projectExtensions);

const SYNTAX: Record<string, Syntax> = Object.assign({}, ...LANGUAGES.map((l) => l.syntax));

/** 語言 ID → 遮罩方式；不認得的語言不遮。 */
export function syntaxForLanguage(languageId: string): Syntax {
  return SYNTAX[languageId] ?? 'none';
}
