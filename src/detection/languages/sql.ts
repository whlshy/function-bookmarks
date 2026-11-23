import { DetectionRule } from '../types';
import { LanguageDef } from './define';

/** 名稱的一段：xxx、"xxx"、[xxx]、`xxx`。 */
const PART = String.raw`(?:[A-Za-z_][\w$#@]*|"[^"\n]+"|\[[^\]\n]+\]|\x60[^\x60\n]+\x60)`;
/** 名稱：可帶結構描述，例如 dbo.xxx、public."xxx"。 */
const NAME = String.raw`${PART}(?:[ \t]*\.[ \t]*${PART}){0,2}`;
/** CREATE [OR REPLACE|OR ALTER]、ALTER，以及 MySQL 的 DEFINER、各家的修飾字。 */
const CREATE = String.raw`^[ \t]*(?:CREATE(?:[ \t]+OR[ \t]+(?:REPLACE|ALTER))?|ALTER)[ \t]+(?:DEFINER[ \t]*=[ \t]*\S+[ \t]+)?(?:(?:TEMP|TEMPORARY|EDITIONABLE|NONEDITIONABLE|SECURE|AGGREGATE)[ \t]+)*`;
const IF_NOT_EXISTS = String.raw`(?:IF[ \t]+NOT[ \t]+EXISTS[ \t]+)?`;

const rules: DetectionRule[] = [
  // ---------- SQL（範圍到敘述結尾：;、GO、/、DELIMITER） ----------
  {
    id: 'sql-routine',
    label: 'CREATE FUNCTION／PROCEDURE xxx',
    languages: ['sql'],
    pattern: String.raw`${CREATE}(?:FUNCTION|PROCEDURE|PROC)[ \t]+${IF_NOT_EXISTS}(?<name>${NAME})`,
    flags: 'i',
    kind: 'function',
    body: 'statement',
  },
  {
    id: 'sql-trigger',
    label: 'CREATE TRIGGER xxx',
    languages: ['sql'],
    pattern: String.raw`${CREATE}(?:CONSTRAINT[ \t]+)?TRIGGER[ \t]+${IF_NOT_EXISTS}(?<name>${NAME})`,
    flags: 'i',
    kind: 'event',
    body: 'statement',
  },
  {
    id: 'sql-view',
    label: 'CREATE VIEW xxx',
    languages: ['sql'],
    pattern: String.raw`${CREATE}(?:MATERIALIZED[ \t]+)?VIEW[ \t]+${IF_NOT_EXISTS}(?<name>${NAME})`,
    flags: 'i',
    kind: 'block',
    body: 'statement',
  },
  {
    id: 'sql-package',
    label: 'CREATE PACKAGE (BODY) xxx（Oracle）',
    languages: ['sql'],
    pattern: String.raw`${CREATE}PACKAGE[ \t]+(?:BODY[ \t]+)?(?<name>${NAME})`,
    flags: 'i',
    kind: 'class',
    body: 'statement',
  },
];

export const sql: LanguageDef = {
  syntax: { sql: 'sql' },
  extensions: { '.sql': 'sql' },
  projectExtensions: ['sql'],
  rules,
};
