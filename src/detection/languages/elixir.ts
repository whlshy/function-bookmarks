import { DetectionRule } from '../types';
import { LanguageDef } from './define';

const EX_MODULE = String.raw`[A-Z]\w*(?:\.[A-Z]\w*)*`;

const rules: DetectionRule[] = [
  // ---------- Elixir（以縮排對齊的 end 結尾；同名的多段 def 合併成一個） ----------
  {
    id: 'ex-module',
    label: 'defmodule／defprotocol／defimpl Xxx do … end',
    languages: ['elixir'],
    pattern: String.raw`^[ \t]*(?:defmodule|defprotocol|defimpl)[ \t]+(?<name>${EX_MODULE})`,
    kind: 'class',
    body: 'end',
  },
  {
    id: 'ex-def',
    label: 'def／defp／defmacro xxx … end',
    languages: ['elixir'],
    pattern: String.raw`^[ \t]*(?:def|defp|defmacro|defmacrop|defguard|defguardp|defdelegate|defn|defnp)[ \t]+(?<name>[a-z_]\w*[?!]?)`,
    kind: 'function',
    body: 'end',
    mergeClauses: true,
  },
  {
    id: 'ex-test',
    label: 'ExUnit 的 describe／test "…" do … end',
    languages: ['elixir'],
    pattern: String.raw`^[ \t]*(?:describe|test)[ \t]+"(?<name>[^"\n]+)"`,
    matchRaw: true,
    kind: 'block',
    body: 'end',
  },
];

export const elixir: LanguageDef = {
  syntax: { elixir: 'elixir' },
  extensions: { '.ex': 'elixir', '.exs': 'elixir' },
  projectExtensions: ['ex', 'exs'],
  rules,
};
