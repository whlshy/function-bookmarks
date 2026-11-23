/** 內建 Django／HTML 規則的 include 會在執行時換成設定 `detection.templateFiles` 的值。 */
export const TEMPLATE_FILES_PLACEHOLDER = '${templateFiles}';

// ---- C 家族共用片段 ----
/** 樣板參數 <…>：最多三層巢狀，< 與 > 必須成對（只有一種切法，長行也不會卡住）。 */
const G_TEXT = String.raw`[^;{}()<>\n]*`;
export const GENERIC = String.raw`<${G_TEXT}(?:<${G_TEXT}(?:<${G_TEXT}>${G_TEXT})*>${G_TEXT})*>`;
/** 後面先遇到 { 才算有本體（遇到 ; 或 } 表示只是宣告或呼叫）。 */
export const HAS_BODY = String.raw`(?=[^;{}]*\{)`;
/** Java／Kotlin 的 @Annotation（同一行）。 */
export const ANNOTATIONS = String.raw`(?:@[A-Za-z_][\w.]*(?:\([^)\n]*\))?[ \t]+)*`;
export const J_KW = 'if|else|for|while|do|switch|case|return|new|throw|try|catch|finally|synchronized|assert|yield|import|package|throws';
/** Java／C# 的型別：String、List<Map<K, V>>、int[]、java.util.List */
export const JVM_TYPE = String.raw`[A-Za-z_][\w.]*(?:${GENERIC})?(?:\[[, ]*\])*`;
