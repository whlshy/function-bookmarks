import { DetectionRule } from '../types';
import { LanguageDef } from './define';
import { TEMPLATE_FILES_PLACEHOLDER } from './fragments';

const TEMPLATE_LANGS = ['html', 'django-html', 'jinja-html', 'jinja'];
const TPL_INCLUDE = [TEMPLATE_FILES_PLACEHOLDER];

const rules: DetectionRule[] = [
  // ---------- Django / Jinja template ----------
  {
    id: 'dj-block',
    label: '{% block %}',
    languages: TEMPLATE_LANGS,
    pattern: '\\{%-?[ \\t]*block[ \\t]+(?<name>\\w+)[ \\t]*-?%\\}',
    end: '\\{%-?[ \\t]*endblock(?:[ \\t]+\\w+)?[ \\t]*-?%\\}',
    kind: 'block',
    body: 'pair',
    include: TPL_INCLUDE,
  },
  {
    id: 'dj-partial',
    label: '{% partialdef %}',
    languages: TEMPLATE_LANGS,
    pattern: '\\{%-?[ \\t]*partialdef[ \\t]+(?<name>[\\w-]+)(?:[ \\t]+inline)?[ \\t]*-?%\\}',
    end: '\\{%-?[ \\t]*endpartialdef(?:[ \\t]+[\\w-]+)?[ \\t]*-?%\\}',
    kind: 'partial',
    body: 'pair',
    include: TPL_INCLUDE,
  },
  {
    id: 'jinja-macro',
    label: '{% macro %}',
    languages: TEMPLATE_LANGS,
    pattern: '\\{%-?[ \\t]*macro[ \\t]+(?<name>\\w+)[ \\t]*\\(',
    end: '\\{%-?[ \\t]*endmacro[ \\t]*-?%\\}',
    kind: 'macro',
    body: 'pair',
    include: TPL_INCLUDE,
  },
  {
    id: 'dj-extends',
    label: '{% extends %}',
    languages: TEMPLATE_LANGS,
    pattern: '\\{%-?[ \\t]*extends[ \\t]+(?<q>["\'])(?<name>(?<target>[^"\'\\n]+))\\k<q>',
    kind: 'reference',
    body: 'line',
    include: TPL_INCLUDE,
  },
  {
    id: 'dj-include',
    label: '{% include %}',
    languages: TEMPLATE_LANGS,
    pattern: '\\{%-?[ \\t]*include[ \\t]+(?<q>["\'])(?<name>(?<target>[^"\'\\n]+))\\k<q>',
    kind: 'reference',
    body: 'line',
    include: TPL_INCLUDE,
  },
  {
    id: 'html-script',
    label: '<script> 內的 JS',
    languages: TEMPLATE_LANGS,
    pattern: '<script\\b(?![^>]*\\bsrc[ \\t]*=)[^>]*>',
    end: '</script[ \\t]*>',
    kind: 'block',
    body: 'embedded',
    embeddedLanguage: 'javascript',
    include: TPL_INCLUDE,
  },
  {
    id: 'html-event-attr',
    label: '<button onclick="…">',
    languages: TEMPLATE_LANGS,
    pattern: String.raw`<(?<tag>[a-zA-Z][\w-]*)\b[^>]*?\bon(?<event>[a-z]+)[ \t]*=[ \t]*(?<q>["'])(?<handler>[^"'\n]{1,80})\k<q>`,
    nameTemplate: '${tag} on${event} → ${handler}',
    kind: 'event',
    body: 'line',
    include: TPL_INCLUDE,
  },
  {
    id: 'html-id',
    label: '<tag id="xxx">',
    languages: TEMPLATE_LANGS,
    pattern: '<[a-zA-Z][\\w-]*\\b[^>]*?\\bid[ \\t]*=[ \\t]*["\'](?<name>[^"\'\\n{}]+)["\']',
    kind: 'block',
    body: 'line',
    include: TPL_INCLUDE,
  },
];

export const django: LanguageDef = {
  syntax: { html: 'template', 'django-html': 'template', 'jinja-html': 'template', jinja: 'template' },
  extensions: { '.html': 'html', '.htm': 'html', '.djhtml': 'django-html', '.jinja': 'jinja-html', '.jinja2': 'jinja-html', '.j2': 'jinja-html' },
  projectExtensions: ['html', 'htm', 'djhtml', 'jinja', 'jinja2', 'j2'],
  rules,
};
