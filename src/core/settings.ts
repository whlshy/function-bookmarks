/**
 * 共用核心：由設定值算出偵測規則、專案檔案範圍。
 * 不依賴編輯器：套件傳入 VS Code 設定，CLI 傳入讀自 .vscode/settings.json 的設定。
 */
import { mergeRules } from '../detection/engine';
import { BUILTIN_RULES, PROJECT_EXTENSIONS, TEMPLATE_FILES_PLACEHOLDER } from '../detection/languages';
import { DetectionRule } from '../detection/types';
import { matchesAny } from '../util/paths';

/** 設定的區段名稱：所有設定鍵都是 functionBookmarks.xxx。 */
export const SECTION = 'functionBookmarks';

/** 讀取 functionBookmarks 底下的設定值（鍵不含區段名稱，例如 'detection.rules'）；沒設定時回傳 fallback。 */
export type ConfigReader = <T>(key: string, fallback: T) => T;

export type DetectionSource = 'rules' | 'languageServer' | 'both';

export interface Settings {
  source: DetectionSource;
  rules: DetectionRule[];
  followCursor: boolean;
}

/** 「整個專案」預設列出的檔案：各語言（detection/languages）的副檔名。package.json 的預設值要一致（有單元測試檢查）。 */
export const DEFAULT_PROJECT_INCLUDE = `**/*.{${PROJECT_EXTENSIONS.join(',')}}`;
export const DEFAULT_PROJECT_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.venv/**',
  '**/venv/**',
  '**/env/**',
  '**/__pycache__/**',
  '**/site-packages/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/staticfiles/**',
  '**/.next/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/target/**',
  '**/vendor/**',
  '**/obj/**',
  '**/.gradle/**',
  '**/Pods/**',
];

/** 內建規則＋使用者規則，扣掉停用的，並把模板檔案的佔位字換成設定的 glob。 */
export function settingsFrom(get: ConfigReader): Settings {
  const templateFiles = get<string[]>('detection.templateFiles', ['**/templates/**']);
  const user = get<DetectionRule[]>('detection.rules', []);
  const disabled = get<string[]>('detection.disabledRules', ['html-id']);
  const templates = Array.isArray(templateFiles) ? templateFiles : ['**/templates/**'];
  const rules = mergeRules(BUILTIN_RULES, Array.isArray(user) ? user : [], Array.isArray(disabled) ? disabled : []).map((r) =>
    r.include?.includes(TEMPLATE_FILES_PLACEHOLDER)
      ? { ...r, include: r.include.flatMap((g) => (g === TEMPLATE_FILES_PLACEHOLDER ? templates : [g])) }
      : r,
  );
  const source = get<DetectionSource>('detection.source', 'rules');
  return {
    source: source === 'languageServer' || source === 'both' ? source : 'rules',
    rules,
    followCursor: get<boolean>('followCursor', true) !== false,
  };
}

export function projectGlobsFrom(get: ConfigReader): { include: string; exclude: string[] } {
  const include = get<string>('project.include', DEFAULT_PROJECT_INCLUDE);
  const exclude = get<string[]>('project.exclude', DEFAULT_PROJECT_EXCLUDE);
  return {
    include: typeof include === 'string' && include ? include : DEFAULT_PROJECT_INCLUDE,
    exclude: Array.isArray(exclude) ? exclude : DEFAULT_PROJECT_EXCLUDE,
  };
}

/**
 * 規則的 include glob 是否符合這個檔案；沒有 include 就一律適用。
 * `rel` 是相對工作區資料夾的路徑，`fullPath` 是完整路徑（兩者任一符合即可）。
 */
export function ruleAppliesTo(rule: DetectionRule, rel: string, fullPath: string): boolean {
  if (!rule.include || rule.include.length === 0) {
    return true;
  }
  return matchesAny(rule.include, rel) || matchesAny(rule.include, fullPath);
}

/** 這個語言、這個檔案可用的規則（啟用中、語言符合、include 符合）。 */
export function applicableRules(rules: DetectionRule[], languageId: string, rel: string, fullPath: string): DetectionRule[] {
  return rules.filter((r) => r.enabled !== false && r.languages.includes(languageId) && ruleAppliesTo(r, rel, fullPath));
}
