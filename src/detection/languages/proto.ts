import { DetectionRule } from '../types';
import { LanguageDef } from './define';

/**
 * Protocol Buffers（.proto）。VS Code 沒有內建 proto 語言：Cursor 內建的是 protobuf，
 * 裝了 vscode-proto3 是 proto3、Buf 等擴充是 proto；都沒裝時依副檔名判斷。
 */
const PROTO_LANGS = ['proto', 'proto3', 'protobuf'];
/** 名稱後面接 {（可在下一行）才算定義，`message foo = 1;` 這種欄位不算。 */
const BLOCK = String.raw`(?=\s*\{)`;

const rules: DetectionRule[] = [
  // ---------- Protocol Buffers ----------
  {
    id: 'proto-service',
    label: 'service Xxx {}',
    languages: PROTO_LANGS,
    pattern: String.raw`^[ \t]*service[ \t]+(?<name>[A-Za-z_]\w*)${BLOCK}`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'proto-rpc',
    label: 'service 內的 rpc Xxx(Req) returns (Resp)',
    languages: PROTO_LANGS,
    pattern: String.raw`^[ \t]*rpc[ \t]+(?<name>[A-Za-z_]\w*)[ \t]*\(`,
    kind: 'method',
    body: 'brace',
    within: ['class'],
  },
  {
    id: 'proto-message',
    label: 'message Xxx {}',
    languages: PROTO_LANGS,
    pattern: String.raw`^[ \t]*message[ \t]+(?<name>[A-Za-z_]\w*)${BLOCK}`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'proto-enum',
    label: 'enum Xxx {}',
    languages: PROTO_LANGS,
    pattern: String.raw`^[ \t]*enum[ \t]+(?<name>[A-Za-z_]\w*)${BLOCK}`,
    kind: 'class',
    body: 'brace',
  },
  {
    id: 'proto-oneof',
    label: 'message 內的 oneof xxx {}',
    languages: PROTO_LANGS,
    pattern: String.raw`^[ \t]*oneof[ \t]+(?<name>[A-Za-z_]\w*)${BLOCK}`,
    kind: 'block',
    body: 'brace',
  },
  {
    id: 'proto-extend',
    label: 'extend Xxx {}',
    languages: PROTO_LANGS,
    pattern: String.raw`^[ \t]*extend[ \t]+(?<name>\.?[A-Za-z_][\w.]*)${BLOCK}`,
    kind: 'block',
    body: 'brace',
  },
];

export const proto: LanguageDef = {
  syntax: { proto: 'proto', proto3: 'proto', protobuf: 'proto' },
  extensions: { '.proto': 'proto' },
  projectExtensions: ['proto'],
  rules,
};
