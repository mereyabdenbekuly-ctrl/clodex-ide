export interface ProjectIndexMount {
  prefix: string;
  absolutePath: string;
}

export interface ProjectIndexSymbol {
  name: string;
  fullName: string;
  kind: string;
  exported: boolean;
  line: number;
  signature?: string;
}

export interface FileIndex {
  mountPrefix: string;
  mountRoot: string;
  absolutePath: string;
  relativePath: string;
  path: string;
  language: string;
  lastModified: number;
  size: number;
  symbols: ProjectIndexSymbol[];
}

export interface ProjectSymbolMatch {
  path: string;
  relativePath: string;
  mountPrefix: string;
  language: string;
  symbol: ProjectIndexSymbol;
}

export interface SearchProjectSymbolsOptions {
  query: string;
  mounts: readonly ProjectIndexMount[];
  maxResults?: number;
}

export interface SearchProjectSymbolsResult {
  query: string;
  totalMatches: number;
  matches: ProjectSymbolMatch[];
  truncated: boolean;
  itemsRemoved: number;
  scannedFiles: number;
  indexedFiles: number;
  skippedFiles: number;
}
