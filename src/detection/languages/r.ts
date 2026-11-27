import { DetectionRule } from '../types';
import { LanguageDef } from './define';

/** 一般名稱（my.fun、.hidden）或反引號名稱（`%||%`）。 */
const R_NAME = String.raw`(?:\x60[^\x60\n]+\x60|[A-Za-z.][\w.]*)`;
/** xxx <- function(…)、xxx = function(…)、xxx <<- function(…)，以及 R 4.1 的 \(x) 簡寫。 */
const R_FUNC = String.raw`^[ \t]*(?<name>${R_NAME})[ \t]*(?:<<-|<-|=)[ \t]*(?:function\b|\\(?=[ \t]*\())`;

const rules: DetectionRule[] = [
  // ---------- R ----------
  {
    id: 'r-class',
    label: 'Xxx <- R6Class(…)／setRefClass(…)',
    languages: ['r'],
    pattern: String.raw`^[ \t]*(?<name>${R_NAME})[ \t]*(?:<-|=)[ \t]*(?:R6::)?(?:R6Class|setRefClass)[ \t]*\(`,
    kind: 'class',
    body: 'call',
  },
  {
    id: 'r-method',
    label: 'R6 類別內的 xxx = function()',
    languages: ['r'],
    pattern: R_FUNC,
    kind: 'method',
    body: 'brace',
    optionalBody: true,
    within: ['class'],
  },
  {
    id: 'r-function',
    label: 'xxx <- function()',
    languages: ['r'],
    pattern: R_FUNC,
    kind: 'function',
    body: 'brace',
    optionalBody: true,
  },
];

export const r: LanguageDef = {
  syntax: { r: 'r' },
  extensions: { '.r': 'r' },
  projectExtensions: ['r', 'R'],
  rules,
};
