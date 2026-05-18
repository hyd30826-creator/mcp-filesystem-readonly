import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  // Pure utility functions
  formatSize,
  normalizeLineEndings,
  // Security & validation functions
  validatePath,
  setAllowedDirectories,
  // File operations
  getFileStats,
  readFileContent,
  // Search & filtering functions
  searchFilesWithValidation,
  // Line-window readers
  tailFile,
  headFile
} from '../lib.js';

// Mock fs module
vi.mock('fs/promises');
const mockFs = fs as any;

describe('Lib Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up allowed directories for tests
    const allowedDirs = process.platform === 'win32' ? ['C:\\Users\\test', 'C:\\temp', 'C:\\allowed'] : ['/home/user', '/tmp', '/allowed'];
    setAllowedDirectories(allowedDirs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clear allowed directories after tests
    setAllowedDirectories([]);
  });

  describe('Pure Utility Functions', () => {
    describe('formatSize', () => {
      it('formats bytes correctly', () => {
        expect(formatSize(0)).toBe('0 B');
        expect(formatSize(512)).toBe('512 B');
        expect(formatSize(1024)).toBe('1.00 KB');
        expect(formatSize(1536)).toBe('1.50 KB');
        expect(formatSize(1048576)).toBe('1.00 MB');
        expect(formatSize(1073741824)).toBe('1.00 GB');
        expect(formatSize(1099511627776)).toBe('1.00 TB');
      });

      it('handles edge cases', () => {
        expect(formatSize(1023)).toBe('1023 B');
        expect(formatSize(1025)).toBe('1.00 KB');
        expect(formatSize(1048575)).toBe('1024.00 KB');
      });

      it('handles very large numbers beyond TB', () => {
        // The function only supports up to TB, so very large numbers will show as TB
        expect(formatSize(1024 * 1024 * 1024 * 1024 * 1024)).toBe('1024.00 TB');
        expect(formatSize(Number.MAX_SAFE_INTEGER)).toContain('TB');
      });

      it('handles negative numbers', () => {
        // Negative numbers will result in NaN for the log calculation
        expect(formatSize(-1024)).toContain('NaN');
        expect(formatSize(-0)).toBe('0 B');
      });

      it('handles decimal numbers', () => {
        expect(formatSize(1536.5)).toBe('1.50 KB');
        expect(formatSize(1023.9)).toBe('1023.9 B');
      });

      it('handles very small positive numbers', () => {
        expect(formatSize(1)).toBe('1 B');
        expect(formatSize(0.5)).toBe('0.5 B');
        expect(formatSize(0.1)).toBe('0.1 B');
      });
    });

    describe('normalizeLineEndings', () => {
      it('converts CRLF to LF', () => {
        expect(normalizeLineEndings('line1\r\nline2\r\nline3')).toBe('line1\nline2\nline3');
      });

      it('leaves LF unchanged', () => {
        expect(normalizeLineEndings('line1\nline2\nline3')).toBe('line1\nline2\nline3');
      });

      it('handles mixed line endings', () => {
        expect(normalizeLineEndings('line1\r\nline2\nline3\r\n')).toBe('line1\nline2\nline3\n');
      });

      it('handles empty string', () => {
        expect(normalizeLineEndings('')).toBe('');
      });
    });

  });

  describe('Security & Validation Functions', () => {
    describe('validatePath', () => {
      // Use Windows-compatible paths for testing
      const allowedDirs = process.platform === 'win32' ? ['C:\\Users\\test', 'C:\\temp'] : ['/home/user', '/tmp'];

      beforeEach(() => {
        mockFs.realpath.mockImplementation(async (path: any) => path.toString());
      });

      it('validates allowed paths', async () => {
        const testPath = process.platform === 'win32' ? 'C:\\Users\\test\\file.txt' : '/home/user/file.txt';
        const result = await validatePath(testPath);
        expect(result).toBe(testPath);
      });

      it('rejects disallowed paths', async () => {
        const testPath = process.platform === 'win32' ? 'C:\\Windows\\System32\\file.txt' : '/etc/passwd';
        await expect(validatePath(testPath))
          .rejects.toThrow('Access denied - path outside allowed directories');
      });

      it('handles non-existent files by checking parent directory', async () => {
        const newFilePath = process.platform === 'win32' ? 'C:\\Users\\test\\newfile.txt' : '/home/user/newfile.txt';
        const parentPath = process.platform === 'win32' ? 'C:\\Users\\test' : '/home/user';
        
        // Create an error with the ENOENT code that the implementation checks for
        const enoentError = new Error('ENOENT') as NodeJS.ErrnoException;
        enoentError.code = 'ENOENT';
        
        mockFs.realpath
          .mockRejectedValueOnce(enoentError)
          .mockResolvedValueOnce(parentPath);
        
        const result = await validatePath(newFilePath);
        expect(result).toBe(path.resolve(newFilePath));
      });

      it('rejects when parent directory does not exist', async () => {
        const newFilePath = process.platform === 'win32' ? 'C:\\Users\\test\\nonexistent\\newfile.txt' : '/home/user/nonexistent/newfile.txt';
        
        // Create errors with the ENOENT code
        const enoentError1 = new Error('ENOENT') as NodeJS.ErrnoException;
        enoentError1.code = 'ENOENT';
        const enoentError2 = new Error('ENOENT') as NodeJS.ErrnoException;
        enoentError2.code = 'ENOENT';
        
        mockFs.realpath
          .mockRejectedValueOnce(enoentError1)
          .mockRejectedValueOnce(enoentError2);
        
        await expect(validatePath(newFilePath))
          .rejects.toThrow('Parent directory does not exist');
      });

      it('resolves relative paths against allowed directories instead of process.cwd()', async () => {
        const relativePath = 'test-file.txt';
        const originalCwd = process.cwd;
        
        // Mock process.cwd to return a directory outside allowed directories
        const disallowedCwd = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/root';
        (process as any).cwd = vi.fn(() => disallowedCwd);
        
        try {
          const result = await validatePath(relativePath);
          
          // Result should be resolved against first allowed directory, not process.cwd()
          const expectedPath = process.platform === 'win32' 
            ? path.resolve('C:\\Users\\test', relativePath)
            : path.resolve('/home/user', relativePath);
          
          expect(result).toBe(expectedPath);
          expect(result).not.toContain(disallowedCwd);
        } finally {
          // Restore original process.cwd
          process.cwd = originalCwd;
        }
      });
    });
  });

  describe('File Operations', () => {
    describe('getFileStats', () => {
      it('returns file statistics', async () => {
        const mockStats = {
          size: 1024,
          birthtime: new Date('2023-01-01'),
          mtime: new Date('2023-01-02'),
          atime: new Date('2023-01-03'),
          isDirectory: () => false,
          isFile: () => true,
          mode: 0o644
        };
        
        mockFs.stat.mockResolvedValueOnce(mockStats as any);
        
        const result = await getFileStats('/test/file.txt');
        
        expect(result).toEqual({
          size: 1024,
          created: new Date('2023-01-01'),
          modified: new Date('2023-01-02'),
          accessed: new Date('2023-01-03'),
          isDirectory: false,
          isFile: true,
          permissions: '644'
        });
      });

      it('handles directory statistics', async () => {
        const mockStats = {
          size: 4096,
          birthtime: new Date('2023-01-01'),
          mtime: new Date('2023-01-02'),
          atime: new Date('2023-01-03'),
          isDirectory: () => true,
          isFile: () => false,
          mode: 0o755
        };
        
        mockFs.stat.mockResolvedValueOnce(mockStats as any);
        
        const result = await getFileStats('/test/dir');
        
        expect(result.isDirectory).toBe(true);
        expect(result.isFile).toBe(false);
        expect(result.permissions).toBe('755');
      });
    });

    describe('readFileContent', () => {
      it('reads file with default encoding', async () => {
        mockFs.readFile.mockResolvedValueOnce('file content');
        
        const result = await readFileContent('/test/file.txt');
        
        expect(result).toBe('file content');
        expect(mockFs.readFile).toHaveBeenCalledWith('/test/file.txt', 'utf-8');
      });

      it('reads file with custom encoding', async () => {
        mockFs.readFile.mockResolvedValueOnce('file content');
        
        const result = await readFileContent('/test/file.txt', 'ascii');
        
        expect(result).toBe('file content');
        expect(mockFs.readFile).toHaveBeenCalledWith('/test/file.txt', 'ascii');
      });
    });

  });

  describe('Search & Filtering Functions', () => {
    describe('searchFilesWithValidation', () => {
      beforeEach(() => {
        mockFs.realpath.mockImplementation(async (path: any) => path.toString());
      });


      it('excludes files matching exclude patterns', async () => {
        const mockEntries = [
          { name: 'test.txt', isDirectory: () => false },
          { name: 'test.log', isDirectory: () => false },
          { name: 'node_modules', isDirectory: () => true }
        ];
        
        mockFs.readdir.mockResolvedValueOnce(mockEntries as any);
        
        const testDir = process.platform === 'win32' ? 'C:\\allowed\\dir' : '/allowed/dir';
        const allowedDirs = process.platform === 'win32' ? ['C:\\allowed'] : ['/allowed'];
        
        // Mock realpath to return the same path for validation to pass
        mockFs.realpath.mockImplementation(async (inputPath: any) => {
          const pathStr = inputPath.toString();
          // Return the path as-is for validation
          return pathStr;
        });
        
        const result = await searchFilesWithValidation(
          testDir,
          '*test*',
          allowedDirs,
          { excludePatterns: ['*.log', 'node_modules'] }
        );
        
        const expectedResult = process.platform === 'win32' ? 'C:\\allowed\\dir\\test.txt' : '/allowed/dir/test.txt';
        expect(result).toEqual([expectedResult]);
      });

      it('handles validation errors during search', async () => {
        const mockEntries = [
          { name: 'test.txt', isDirectory: () => false },
          { name: 'invalid_file.txt', isDirectory: () => false }
        ];
        
        mockFs.readdir.mockResolvedValueOnce(mockEntries as any);
        
        // Mock validatePath to throw error for invalid_file.txt
        mockFs.realpath.mockImplementation(async (path: any) => {
          if (path.toString().includes('invalid_file.txt')) {
            throw new Error('Access denied');
          }
          return path.toString();
        });
        
        const testDir = process.platform === 'win32' ? 'C:\\allowed\\dir' : '/allowed/dir';
        const allowedDirs = process.platform === 'win32' ? ['C:\\allowed'] : ['/allowed'];
        
        const result = await searchFilesWithValidation(
          testDir,
          '*test*',
          allowedDirs,
          {}
        );
        
        // Should only return the valid file, skipping the invalid one
        const expectedResult = process.platform === 'win32' ? 'C:\\allowed\\dir\\test.txt' : '/allowed/dir/test.txt';
        expect(result).toEqual([expectedResult]);
      });

      it('handles complex exclude patterns with wildcards', async () => {
        const mockEntries = [
          { name: 'test.txt', isDirectory: () => false },
          { name: 'test.backup', isDirectory: () => false },
          { name: 'important_test.js', isDirectory: () => false }
        ];
        
        mockFs.readdir.mockResolvedValueOnce(mockEntries as any);
        
        const testDir = process.platform === 'win32' ? 'C:\\allowed\\dir' : '/allowed/dir';
        const allowedDirs = process.platform === 'win32' ? ['C:\\allowed'] : ['/allowed'];
        
        const result = await searchFilesWithValidation(
          testDir,
          '*test*',
          allowedDirs,
          { excludePatterns: ['*.backup'] }
        );
        
        const expectedResults = process.platform === 'win32' ? [
          'C:\\allowed\\dir\\test.txt',
          'C:\\allowed\\dir\\important_test.js'
        ] : [
          '/allowed/dir/test.txt',
          '/allowed/dir/important_test.js'
        ];
        expect(result).toEqual(expectedResults);
      });
    });
  });

  describe('Line-Window Read Functions', () => {
    describe('tailFile', () => {
      it('handles empty files', async () => {
        mockFs.stat.mockResolvedValue({ size: 0 } as any);
        
        const result = await tailFile('/test/empty.txt', 5);
        
        expect(result).toBe('');
        expect(mockFs.open).not.toHaveBeenCalled();
      });

      it('calls stat to check file size', async () => {
        mockFs.stat.mockResolvedValue({ size: 100 } as any);
        
        // Mock file handle with proper typing
        const mockFileHandle = {
          read: vi.fn(),
          close: vi.fn()
        } as any;
        
        mockFileHandle.read.mockResolvedValue({ bytesRead: 0 });
        mockFileHandle.close.mockResolvedValue(undefined);
        
        mockFs.open.mockResolvedValue(mockFileHandle);
        
        await tailFile('/test/file.txt', 2);
        
        expect(mockFs.stat).toHaveBeenCalledWith('/test/file.txt');
        expect(mockFs.open).toHaveBeenCalledWith('/test/file.txt', 'r');
      });

      it('handles files with content and returns last lines', async () => {
        mockFs.stat.mockResolvedValue({ size: 50 } as any);
        
        const mockFileHandle = {
          read: vi.fn(),
          close: vi.fn()
        } as any;
        
        // Simulate reading file content in chunks
        mockFileHandle.read
          .mockResolvedValueOnce({ bytesRead: 20, buffer: Buffer.from('line3\nline4\nline5\n') })
          .mockResolvedValueOnce({ bytesRead: 0 });
        mockFileHandle.close.mockResolvedValue(undefined);
        
        mockFs.open.mockResolvedValue(mockFileHandle);
        
        const result = await tailFile('/test/file.txt', 2);
        
        expect(mockFileHandle.close).toHaveBeenCalled();
      });

      it('handles read errors gracefully', async () => {
        mockFs.stat.mockResolvedValue({ size: 100 } as any);
        
        const mockFileHandle = {
          read: vi.fn(),
          close: vi.fn()
        } as any;
        
        mockFileHandle.read.mockResolvedValue({ bytesRead: 0 });
        mockFileHandle.close.mockResolvedValue(undefined);
        
        mockFs.open.mockResolvedValue(mockFileHandle);
        
        await tailFile('/test/file.txt', 5);
        
        expect(mockFileHandle.close).toHaveBeenCalled();
      });
    });

    describe('headFile', () => {
      it('opens file for reading', async () => {
        // Mock file handle with proper typing
        const mockFileHandle = {
          read: vi.fn(),
          close: vi.fn()
        } as any;
        
        mockFileHandle.read.mockResolvedValue({ bytesRead: 0 });
        mockFileHandle.close.mockResolvedValue(undefined);
        
        mockFs.open.mockResolvedValue(mockFileHandle);
        
        await headFile('/test/file.txt', 2);
        
        expect(mockFs.open).toHaveBeenCalledWith('/test/file.txt', 'r');
      });

      it('handles files with content and returns first lines', async () => {
        const mockFileHandle = {
          read: vi.fn(),
          close: vi.fn()
        } as any;
        
        // Simulate reading file content with newlines
        mockFileHandle.read
          .mockResolvedValueOnce({ bytesRead: 20, buffer: Buffer.from('line1\nline2\nline3\n') })
          .mockResolvedValueOnce({ bytesRead: 0 });
        mockFileHandle.close.mockResolvedValue(undefined);
        
        mockFs.open.mockResolvedValue(mockFileHandle);
        
        const result = await headFile('/test/file.txt', 2);
        
        expect(mockFileHandle.close).toHaveBeenCalled();
      });

      it('handles files with leftover content', async () => {
        const mockFileHandle = {
          read: vi.fn(),
          close: vi.fn()
        } as any;
        
        // Simulate reading file content without final newline
        mockFileHandle.read
          .mockResolvedValueOnce({ bytesRead: 15, buffer: Buffer.from('line1\nline2\nend') })
          .mockResolvedValueOnce({ bytesRead: 0 });
        mockFileHandle.close.mockResolvedValue(undefined);
        
        mockFs.open.mockResolvedValue(mockFileHandle);
        
        const result = await headFile('/test/file.txt', 5);
        
        expect(mockFileHandle.close).toHaveBeenCalled();
      });

      it('handles reaching requested line count', async () => {
        const mockFileHandle = {
          read: vi.fn(),
          close: vi.fn()
        } as any;
        
        // Simulate reading exactly the requested number of lines
        mockFileHandle.read
          .mockResolvedValueOnce({ bytesRead: 12, buffer: Buffer.from('line1\nline2\n') })
          .mockResolvedValueOnce({ bytesRead: 0 });
        mockFileHandle.close.mockResolvedValue(undefined);
        
        mockFs.open.mockResolvedValue(mockFileHandle);
        
        const result = await headFile('/test/file.txt', 2);
        
        expect(mockFileHandle.close).toHaveBeenCalled();
      });
    });
  });
});
