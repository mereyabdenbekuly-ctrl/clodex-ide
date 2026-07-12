/**
 * AST index module — Node entry point.
 *
 * Provides `getFileSymbols()`, the single public API for parsing source
 * code and extracting top-level symbols. Internally wires up the
 * Node-native parser, grammar loader, and symbol extractor.
 */

import type { ParsedFileSymbols } from '../../ast';
import { getLanguageForExt } from '../../ast';
import { initParser, loadGrammar } from './parser';
import { extractSymbols } from './symbol-extractor';
import type { Node } from 'web-tree-sitter';

export type { ParsedFileSymbols } from '../../ast';
export { SymbolKind, type SymbolInfo } from '../../ast';
export { getLanguageForExt } from '../../ast';

export interface SymbolRange {
  name: string;
  fullName: string;
  kind: string;
  startLine: number;
  endLine: number;
}

/**
 * Parse source code and extract top-level symbols.
 *
 * @param sourceText — UTF-8 source code string (NOT a URL or file path).
 * @param ext — File extension without leading dot (e.g. `'ts'`, `'py'`, `'go'`).
 * @returns Parsed symbols, or `null` if the extension has no grammar.
 */
export async function getFileSymbols(
  sourceText: string,
  ext: string,
): Promise<ParsedFileSymbols | null> {
  const lang = getLanguageForExt(ext);
  if (!lang) return null;

  const parser = await initParser();
  let tree: ReturnType<typeof parser.parse> | null = null;

  try {
    const language = await loadGrammar(lang.grammarFile);
    parser.setLanguage(language);
    tree = parser.parse(sourceText);
    if (!tree) return null;

    const symbols = extractSymbols(
      tree.rootNode,
      lang.grammarFile,
      sourceText,
      ext,
    );
    return { language: lang.label, symbols };
  } finally {
    tree?.delete();
    parser.delete();
  }
}

/**
 * Locate source ranges for symbol-like declarations by name.
 *
 * This intentionally uses a generic Tree-sitter traversal instead of the
 * outline extractor so it can return exact start/end ranges without coupling
 * every language-specific extractor to edit/navigation use cases.
 */
export async function getFileSymbolRanges(
  sourceText: string,
  ext: string,
  symbolName: string,
): Promise<SymbolRange[] | null> {
  const lang = getLanguageForExt(ext);
  if (!lang) return null;

  const parser = await initParser();
  let tree: ReturnType<typeof parser.parse> | null = null;

  try {
    const language = await loadGrammar(lang.grammarFile);
    parser.setLanguage(language);
    tree = parser.parse(sourceText);
    if (!tree) return null;

    const matches: SymbolRange[] = [];
    const normalizedTarget = normalizeSymbolName(symbolName);

    function visit(node: Node, scope: readonly string[]): void {
      const symbol = getNodeSymbol(node);
      const nextScope =
        symbol && symbol.name !== '<anonymous>'
          ? [...scope, symbol.name]
          : scope;

      if (symbol) {
        const fullName = nextScope.join('.');
        if (symbolMatches(normalizedTarget, symbol.name, fullName)) {
          const rangeNode = getRangeNode(node);
          matches.push({
            name: symbol.name,
            fullName,
            kind: symbol.kind,
            startLine: rangeNode.startPosition.row + 1,
            endLine: rangeNode.endPosition.row + 1,
          });
        }
      }

      for (const child of node.namedChildren) {
        visit(child, nextScope);
      }
    }

    visit(tree.rootNode, []);
    return matches;
  } finally {
    tree?.delete();
    parser.delete();
  }
}

const SYMBOLISH_NODE_TYPES = new Set([
  'abstract_class_declaration',
  'class',
  'class_declaration',
  'class_specifier',
  'decorated_definition',
  'enum_declaration',
  'enum_item',
  'enum_specifier',
  'function_declaration',
  'function_definition',
  'function_item',
  'interface_declaration',
  'method',
  'method_declaration',
  'method_definition',
  'module',
  'namespace_declaration',
  'namespace_definition',
  'property_definition',
  'public_field_definition',
  'struct_item',
  'struct_specifier',
  'trait_item',
  'type_alias_declaration',
  'type_spec',
  'variable_declarator',
]);

function getNodeSymbol(node: Node): { name: string; kind: string } | null {
  if (!SYMBOLISH_NODE_TYPES.has(node.type)) return null;

  const nameNode =
    node.childForFieldName('name') ??
    node.childForFieldName('declarator')?.childForFieldName('declarator');
  const name = nameNode?.text;
  if (!name) return null;

  return {
    name,
    kind: kindForNodeType(node.type),
  };
}

function getRangeNode(node: Node): Node {
  if (
    node.type === 'variable_declarator' &&
    (node.parent?.type === 'lexical_declaration' ||
      node.parent?.type === 'variable_declaration')
  ) {
    return node.parent;
  }
  return node;
}

function kindForNodeType(type: string): string {
  if (type.includes('class') || type.includes('struct')) return 'class';
  if (type.includes('interface') || type.includes('trait')) return 'interface';
  if (type.includes('enum')) return 'enum';
  if (type.includes('method')) return 'method';
  if (type.includes('property') || type.includes('field')) return 'property';
  if (type.includes('type')) return 'type';
  if (type.includes('variable')) return 'variable';
  if (type === 'module' || type.includes('namespace')) return 'module';
  return 'function';
}

function normalizeSymbolName(value: string): string {
  return value.trim();
}

function symbolMatches(
  target: string,
  name: string,
  fullName: string,
): boolean {
  if (!target) return false;
  if (target === name || target === fullName) return true;

  const targetLastSegment = target.split('.').at(-1);
  return targetLastSegment === name;
}
