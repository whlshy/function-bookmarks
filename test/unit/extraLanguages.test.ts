import * as assert from 'assert';
import { detect, outline } from './helpers';
import {
  MYSQL_SAMPLE,
  ORACLE_SAMPLE,
  PG_SQL_SAMPLE,
  PROTO_SAMPLE,
  SHELL_SAMPLE,
  SVELTE_SAMPLE,
  TSQL_SAMPLE,
  VUE_SAMPLE,
} from './extraLanguageSamples';

const crlf = (t: string) => t.replace(/\n/g, '\r\n');

describe('Protocol Buffers、Vue／Svelte、Shell、SQL', () => {
  it('Protocol Buffers：service 底下列 rpc（有沒有本體、stream、多行 option），巢狀 message、enum、oneof、extend；註解與欄位名稱不算', () => {
    const want = {
      'class Greeter@4-10': { 'method SayHello@5-5': {}, 'method Watch@6-6': {}, 'method WithOptions@7-9': {} },
      'class HelloRequest@12-26': { 'class Inner@14-16': {}, 'class Mood@17-19': {}, 'block choice@20-23': {} },
      'class HelloReply@28-28': {},
      'block google.protobuf.MessageOptions@30-32': {},
    };
    for (const lang of ['proto', 'proto3', 'protobuf']) {
      assert.deepStrictEqual(outline(detect(PROTO_SAMPLE, lang).symbols), want, lang);
    }
    assert.deepStrictEqual(outline(detect(crlf(PROTO_SAMPLE), 'proto').symbols), want, 'CRLF');
  });

  it('Vue：<script setup lang="ts"> 的函式；template、style 不列', () => {
    assert.deepStrictEqual(outline(detect(VUE_SAMPLE, 'vue').symbols), { 'function save@7-9': {}, 'function reset@10-12': {} });
  });

  it('Svelte：多個 <script>（含 context="module"）', () => {
    assert.deepStrictEqual(outline(detect(SVELTE_SAMPLE, 'svelte').symbols), { 'function preload@1-3': {}, 'function increment@8-10': {} });
  });

  it('Vue：lang="tsx" 用 TSX 的規則；有 src 的 <script> 沒有內容', () => {
    const t = ['<script src="./x.js"></script>', '<script lang="tsx">', 'const Item = () => <li>{1}</li>;', 'function list() {', '  return <ul></ul>;', '}', '</script>'].join('\n');
    assert.deepStrictEqual(Object.keys(outline(detect(t, 'vue').symbols, false)), ['function Item', 'function list']);
  });

  it('Shell：function xxx {}、xxx() {}；註解、字串、${#x}、heredoc 裡的 { } 不影響範圍', () => {
    const want = { 'function log@4-6': {}, 'function deploy@8-17': {}, 'function cleanup@19-21': {} };
    assert.deepStrictEqual(outline(detect(SHELL_SAMPLE, 'shellscript').symbols), want);
    assert.deepStrictEqual(outline(detect(crlf(SHELL_SAMPLE), 'shellscript').symbols), want, 'CRLF');
  });

  it('Shell：case 的匹配樣式 {) 不會讓大括號配錯', () => {
    const t = ['pick() {', '  case "$1" in', '    {) echo open ;;', '    *) echo other ;;', '  esac', '}', 'next() {', '  :', '}'].join('\n');
    assert.deepStrictEqual(outline(detect(t, 'shellscript').symbols), { 'function pick@0-5': {}, 'function next@6-8': {} });
  });

  it('SQL（PostgreSQL）：$$ 本體、CASE … END、字串裡的 END; 都不會提早結束；CREATE TABLE 不列', () => {
    const want = { 'function public.add_one@1-6': {}, 'block active_users@10-13': {}, 'event trg_audit@15-17': {} };
    assert.deepStrictEqual(outline(detect(PG_SQL_SAMPLE, 'sql').symbols), want);
    assert.deepStrictEqual(outline(detect(crlf(PG_SQL_SAMPLE), 'sql').symbols), want, 'CRLF');
  });

  it('SQL（MySQL）：DELIMITER 期間以分隔字串結尾，END IF 不算結束；小寫的 create view 也認得', () => {
    assert.deepStrictEqual(outline(detect(MYSQL_SAMPLE, 'sql').symbols), { 'function `get_user`@1-6': {}, 'block v1@9-9': {} });
  });

  it('SQL（SQL Server）：以 GO 分隔，BEGIN TRANSACTION 不算區塊', () => {
    const want = { 'function [dbo].[usp_List]@0-7': {}, 'function dbo.fn_Two@10-14': {} };
    assert.deepStrictEqual(outline(detect(TSQL_SAMPLE, 'sql').symbols), want);
    assert.deepStrictEqual(outline(detect(crlf(TSQL_SAMPLE), 'sql').symbols), want, 'CRLF');
  });

  it('SQL（SQL Server）：下一個 CREATE VIEW 前漏寫 GO 時，到上一個分號為止；程序內的 CREATE TABLE 不算', () => {
    const t = [
      'CREATE VIEW dbo.a AS',
      'SELECT 1 AS x;',
      'CREATE VIEW dbo.b AS',
      'SELECT 2 AS y;',
      'GO',
      'CREATE PROCEDURE dbo.p AS',
      'CREATE TABLE #t (id int);',
      'SELECT * FROM #t;',
      'GO',
      'CREATE OR ALTER VIEW dbo.c AS',
      'SELECT 3 AS z',
    ].join('\n');
    const want = { 'block dbo.a@0-1': {}, 'block dbo.b@2-3': {}, 'function dbo.p@5-7': {}, 'block dbo.c@9-10': {} };
    assert.deepStrictEqual(outline(detect(t, 'sql').symbols), want);
    assert.deepStrictEqual(outline(detect(crlf(t), 'sql').symbols), want, 'CRLF');
  });

  it('Vue／Svelte：template 裡被 HTML 註解掉的 <script> 不列；script 裡的 <!-- 字串不影響', () => {
    const t = [
      '<template>',
      '  <!-- <script>',
      '  function old() {}',
      '  </script> -->',
      '  <div />',
      '</template>',
      '<script>',
      "const s = '<!--';",
      'function keep() {}',
      '</script>',
      '<!-- <script>function gone() {}</script> -->',
    ].join('\n');
    for (const lang of ['vue', 'svelte']) {
      assert.deepStrictEqual(Object.keys(outline(detect(t, lang).symbols, false)), ['function keep'], lang);
      assert.deepStrictEqual(Object.keys(outline(detect(crlf(t), lang).symbols, false)), ['function keep'], `${lang} CRLF`);
    }
  });

  it('Vue：lang="jsx" 用 JSX 的規則；標籤與 lang 不分大小寫', () => {
    const jsx = ['<script lang="jsx">', 'const Item = () => <li>{1}</li>;', 'function list() {', '  return <ul></ul>;', '}', '</script>'].join('\n');
    assert.deepStrictEqual(Object.keys(outline(detect(jsx, 'vue').symbols, false)), ['function Item', 'function list']);
    const upper = ['<SCRIPT LANG="TS">', 'function typed(x: number): number {', '  return x;', '}', '</SCRIPT>'].join('\n');
    assert.deepStrictEqual(Object.keys(outline(detect(upper, 'vue').symbols, false)), ['function typed']);
  });

  it('SQL（Oracle）：以 / 分隔，宣告區與套件內程序的 ; 不算結束；VIEW 仍以 ; 結尾', () => {
    const want = { 'function raise_salary@0-4': {}, 'block emp_v@7-7': {}, 'class pkg@9-14': {} };
    assert.deepStrictEqual(outline(detect(ORACLE_SAMPLE, 'sql').symbols), want);
    assert.deepStrictEqual(outline(detect(crlf(ORACLE_SAMPLE), 'sql').symbols), want, 'CRLF');
  });

  it('很長的檔案也很快', () => {
    const big = (s: string, n: number) => Array(n).fill(s).join('\n');
    for (const [text, lang] of [
      [big(PROTO_SAMPLE, 300), 'proto'],
      [big(SHELL_SAMPLE, 300), 'shellscript'],
      [big(PG_SQL_SAMPLE, 300), 'sql'],
      [big(VUE_SAMPLE, 300), 'vue'],
    ] as const) {
      const t0 = Date.now();
      detect(text, lang);
      assert.ok(Date.now() - t0 < 2000, `${lang} ${Date.now() - t0}ms`);
    }
  });
});
