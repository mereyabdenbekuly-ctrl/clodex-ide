import { describe, it, expect } from 'vitest';
import {
  normalizePath,
  getBaseName,
  getParentPath,
  splitSegments,
} from './path-utils';

describe('normalizePath', () => {
  it('leaves unix paths unchanged', () => {
    expect(normalizePath('/home/user/project')).toBe('/home/user/project');
  });

  it('converts windows backslashes to forward slashes', () => {
    expect(normalizePath('C:\\Users\\me\\project')).toBe('C:/Users/me/project');
  });

  it('handles mixed separators', () => {
    expect(normalizePath('C:\\Users/me\\project/src')).toBe(
      'C:/Users/me/project/src',
    );
  });

  it('preserves drive letters', () => {
    expect(normalizePath('D:\\')).toBe('D:/');
  });

  it('returns empty string for empty input', () => {
    expect(normalizePath('')).toBe('');
  });

  it('handles paths with no separators', () => {
    expect(normalizePath('file.txt')).toBe('file.txt');
  });
});

describe('getBaseName', () => {
  it('returns last segment of a unix path', () => {
    expect(getBaseName('/home/user/project')).toBe('project');
  });

  it('returns last segment of a windows path', () => {
    expect(getBaseName('C:\\Users\\me\\project')).toBe('project');
  });

  it('returns last segment of a mixed path', () => {
    expect(getBaseName('C:\\Users/me\\project')).toBe('project');
  });

  it('returns full input when no separator is present', () => {
    expect(getBaseName('file.txt')).toBe('file.txt');
  });

  it('returns last segment when path has trailing separator', () => {
    expect(getBaseName('/home/user/project/')).toBe('project');
  });

  it('returns empty string for empty input', () => {
    expect(getBaseName('')).toBe('');
  });

  it('handles deep nested path', () => {
    expect(getBaseName('a/b/c/d/e.ts')).toBe('e.ts');
  });

  it('handles deep nested windows path', () => {
    expect(getBaseName('a\\b\\c\\d\\e.ts')).toBe('e.ts');
  });
});

describe('getParentPath', () => {
  it('returns parent of a unix path', () => {
    expect(getParentPath('/home/user/project')).toBe('/home/user');
  });

  it('returns parent of a windows path', () => {
    expect(getParentPath('C:\\Users\\me\\project')).toBe('C:\\Users\\me');
  });

  it('returns empty string for a single segment', () => {
    expect(getParentPath('file.txt')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(getParentPath('')).toBe('');
  });

  it('handles root unix path', () => {
    expect(getParentPath('/file.txt')).toBe('');
  });

  it('handles mixed separators', () => {
    expect(getParentPath('C:\\Users/me\\project')).toBe('C:\\Users/me');
  });
});

describe('splitSegments', () => {
  it('splits unix path', () => {
    expect(splitSegments('/home/user/project')).toEqual([
      'home',
      'user',
      'project',
    ]);
  });

  it('splits windows path', () => {
    expect(splitSegments('C:\\Users\\me\\project')).toEqual([
      'C:',
      'Users',
      'me',
      'project',
    ]);
  });

  it('splits mixed separators', () => {
    expect(splitSegments('C:\\Users/me\\project')).toEqual([
      'C:',
      'Users',
      'me',
      'project',
    ]);
  });

  it('filters empty segments from leading/trailing separators', () => {
    expect(splitSegments('/a/b/c/')).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array for empty input', () => {
    expect(splitSegments('')).toEqual([]);
  });

  it('returns single-element array for no-separator input', () => {
    expect(splitSegments('file.txt')).toEqual(['file.txt']);
  });
});
