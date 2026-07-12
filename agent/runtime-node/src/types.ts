/**
 * Configuration for file system providers
 */
export interface FileSystemProviderConfig {
  workingDirectory: string;
  rgBinaryBasePath: string;
}

/**
 * Minimal interface for file system operations needed by grep/glob
 * This avoids circular imports while providing type safety
 */
export interface FileSystemOperations {
  getCurrentWorkingDirectory(): string;
  isIgnored(relativePath: string): Promise<boolean>;
  isDirectory(relativePath: string): Promise<boolean>;
  resolvePath(relativePath: string): string;
}

/**
 * File change event for file watching
 */
export interface FileChangeEvent {
  type: 'create' | 'update' | 'delete';
  file: {
    absolutePath: string;
    relativePath: string;
  };
}

/**
 * Base result type for file operations
 */
export interface FileOperationResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Result type for file content operations
 */
export interface FileContentResult extends FileOperationResult {
  content?: string;
  totalLines?: number;
}

/**
 * Directory entry type
 */
export interface DirectoryEntry {
  relativePath: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  depth: number;
}

/**
 * Result type for directory listing
 */
export interface DirectoryListResult extends FileOperationResult {
  files?: DirectoryEntry[];
  totalFiles?: number;
  totalDirectories?: number;
}

/**
 * Options for grep operations
 */
export interface GrepOptions {
  recursive?: boolean;
  maxDepth?: number;
  filePattern?: string;
  absoluteSearchPath?: string;
  caseSensitive?: boolean;
  maxMatches?: number;
  excludePatterns?: string[];
  respectGitignore?: boolean;
}

/**
 * Single grep match
 */
export interface GrepMatch {
  relativePath: string;
  absolutePath: string;
  line: number;
  column: number;
  match: string;
  preview: string;
}

/**
 * Result type for grep operations
 */
export interface GrepResult extends FileOperationResult {
  matches?: GrepMatch[];
  totalMatches?: number;
  filesSearched?: number;
}

/**
 * Options for glob operations
 */
export interface GlobOptions {
  absoluteSearchPath?: string;
  excludePatterns?: string[];
  respectGitignore?: boolean;
  maxResults?: number;
}

/**
 * Result type for glob operations
 */
export interface GlobResult extends FileOperationResult {
  relativePaths: string[];
  absolutePaths: string[];
  totalMatches?: number;
}

/**
 * Single search/replace match
 */
export interface SearchReplaceMatch {
  line: number;
  column: number;
  oldText: string;
  newText: string;
  lineContent: string;
}

/**
 * Result type for search/replace operations
 */
export interface SearchReplaceResult extends FileOperationResult {
  replacements?: SearchReplaceMatch[];
  totalReplacements?: number;
  fileModified?: boolean;
}
