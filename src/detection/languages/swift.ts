import { DetectionRule } from '../types';
import { LanguageDef } from './define';

/** Swift 的註解與字串寫法和 Kotlin 相同。 */
const SWIFT_FUNC = String.raw`^[ \t]*(?:@\w+(?:\([^)\n]*\))?[ \t]+)*(?:(?:public|private|fileprivate|internal|open|final|static|class|override|mutating|nonmutating|convenience|required|nonisolated)[ \t]+)*(?:func[ \t]+|(?=(?:init|deinit)[?!]?[ \t]*[<({]))(?<name>[A-Za-z_]\w*)`;

const rules: DetectionRule[] = [
  // ---------- Swift ----------
  {
    id: 'swift-type',
    label: 'class／struct／enum／protocol／extension Xxx',
    languages: ['swift'],
    pattern: String.raw`^[ \t]*(?:@\w+(?:\([^)\n]*\))?[ \t]+)*(?:(?:public|private|fileprivate|internal|open|final|indirect)[ \t]+)*(?:class|struct|enum|protocol|extension|actor)[ \t]+(?<name>[A-Za-z_][\w.]*)`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'swift-method',
    label: '型別內的 func xxx()／init()',
    languages: ['swift'],
    pattern: SWIFT_FUNC,
    kind: 'method',
    body: 'brace',
    optionalBody: true,
    within: ['class'],
  },
  {
    id: 'swift-func',
    label: 'func xxx()',
    languages: ['swift'],
    pattern: SWIFT_FUNC,
    kind: 'function',
    body: 'brace',
    optionalBody: true,
  },
];

export const swift: LanguageDef = {
  syntax: { swift: 'kotlin' },
  extensions: { '.swift': 'swift' },
  projectExtensions: ['swift'],
  rules,
};
