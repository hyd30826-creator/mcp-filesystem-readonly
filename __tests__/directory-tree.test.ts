import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { minimatch } from 'minimatch';

interface TreeEntry {
    name: string;
    type: 'file' | 'directory';
    children?: TreeEntry[];
}

interface BuildTreeOptions {
    excludePatterns?: string[];
    maxDepth?: number | null;
    maxNodes?: number | null;
    dirsOnly?: boolean;
}

interface BuildTreeResult {
    tree: TreeEntry[];
    truncated: boolean;
    totalIncluded: number;
    reason?: string;
}

async function buildTreeForTesting(
    currentPath: string,
    rootPath: string,
    options: BuildTreeOptions = {}
): Promise<BuildTreeResult> {
    const {
        excludePatterns = [],
        maxDepth = 5,
        maxNodes = 1000,
        dirsOnly = false,
    } = options;

    const counter = { count: 0 };
    let truncated = false;
    let truncationReason: string | undefined;

    async function walk(walkPath: string, depth: number): Promise<TreeEntry[]> {
        const entries = await fs.readdir(walkPath, { withFileTypes: true });
        const result: TreeEntry[] = [];

        for (const entry of entries) {
            if (truncated) break;

            const relativePath = path.relative(rootPath, path.join(walkPath, entry.name));
            const shouldExclude = excludePatterns.some(pattern => {
                if (pattern.includes('*')) {
                    return minimatch(relativePath, pattern, { dot: true });
                }
                return minimatch(relativePath, pattern, { dot: true }) ||
                       minimatch(relativePath, `**/${pattern}`, { dot: true }) ||
                       minimatch(relativePath, `**/${pattern}/**`, { dot: true });
            });
            if (shouldExclude) continue;

            if (dirsOnly && !entry.isDirectory()) continue;

            if (maxNodes !== null && counter.count >= maxNodes) {
                truncated = true;
                truncationReason = 'maxNodes';
                break;
            }

            counter.count++;

            const entryData: TreeEntry = {
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : 'file'
            };

            if (entry.isDirectory()) {
                if (maxDepth !== null && depth >= maxDepth) {
                    entryData.children = [];
                } else {
                    const subPath = path.join(walkPath, entry.name);
                    entryData.children = await walk(subPath, depth + 1);
                }
            }

            result.push(entryData);
        }

        return result;
    }

    const tree = await walk(currentPath, 0);

    return {
        tree,
        truncated,
        totalIncluded: counter.count,
        ...(truncated && truncationReason ? { reason: truncationReason } : {}),
    };
}

describe('buildTree exclude patterns', () => {
    let testDir: string;

    beforeEach(async () => {
        testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filesystem-test-'));

        await fs.mkdir(path.join(testDir, 'src'));
        await fs.mkdir(path.join(testDir, 'node_modules'));
        await fs.mkdir(path.join(testDir, '.git'));
        await fs.mkdir(path.join(testDir, 'nested', 'node_modules'), { recursive: true });

        await fs.writeFile(path.join(testDir, '.env'), 'SECRET=value');
        await fs.writeFile(path.join(testDir, '.env.local'), 'LOCAL_SECRET=value');
        await fs.writeFile(path.join(testDir, 'src', 'index.js'), 'console.log("hello");');
        await fs.writeFile(path.join(testDir, 'package.json'), '{}');
        await fs.writeFile(path.join(testDir, 'node_modules', 'module.js'), 'module.exports = {};');
        await fs.writeFile(path.join(testDir, 'nested', 'node_modules', 'deep.js'), 'module.exports = {};');
    });

    afterEach(async () => {
        await fs.rm(testDir, { recursive: true, force: true });
    });

    it('should exclude files matching simple patterns', async () => {
        const result = await buildTreeForTesting(testDir, testDir, { excludePatterns: ['.env'] });
        const fileNames = result.tree.map(entry => entry.name);

        expect(fileNames).not.toContain('.env');
        expect(fileNames).toContain('.env.local');
        expect(fileNames).toContain('src');
        expect(fileNames).toContain('package.json');
        expect(result.truncated).toBe(false);
    });

    it('should exclude directories matching simple patterns', async () => {
        const result = await buildTreeForTesting(testDir, testDir, { excludePatterns: ['node_modules'] });
        const dirNames = result.tree.map(entry => entry.name);

        expect(dirNames).not.toContain('node_modules');
        expect(dirNames).toContain('src');
        expect(dirNames).toContain('.git');
    });

    it('should exclude nested directories with same pattern', async () => {
        const result = await buildTreeForTesting(testDir, testDir, { excludePatterns: ['node_modules'] });

        const nestedDir = result.tree.find(entry => entry.name === 'nested');
        expect(nestedDir).toBeDefined();
        expect(nestedDir!.children).toBeDefined();

        const nestedChildren = nestedDir!.children!.map(child => child.name);
        expect(nestedChildren).not.toContain('node_modules');
    });

    it('should handle glob patterns correctly', async () => {
        const result = await buildTreeForTesting(testDir, testDir, { excludePatterns: ['*.env'] });
        const fileNames = result.tree.map(entry => entry.name);

        expect(fileNames).not.toContain('.env');
        expect(fileNames).toContain('.env.local');
        expect(fileNames).toContain('src');
    });

    it('should handle dot files correctly', async () => {
        const result = await buildTreeForTesting(testDir, testDir, { excludePatterns: ['.git'] });
        const dirNames = result.tree.map(entry => entry.name);

        expect(dirNames).not.toContain('.git');
        expect(dirNames).toContain('.env');
    });

    it('should work with multiple exclude patterns', async () => {
        const result = await buildTreeForTesting(testDir, testDir, {
            excludePatterns: ['node_modules', '.env', '.git'],
        });
        const entryNames = result.tree.map(entry => entry.name);

        expect(entryNames).not.toContain('node_modules');
        expect(entryNames).not.toContain('.env');
        expect(entryNames).not.toContain('.git');
        expect(entryNames).toContain('src');
        expect(entryNames).toContain('package.json');
    });

    it('should handle empty exclude patterns', async () => {
        const result = await buildTreeForTesting(testDir, testDir, { excludePatterns: [] });
        const entryNames = result.tree.map(entry => entry.name);

        expect(entryNames).toContain('node_modules');
        expect(entryNames).toContain('.env');
        expect(entryNames).toContain('.git');
        expect(entryNames).toContain('src');
    });
});

describe('directory_tree safeguards', () => {
    let testDir: string;

    beforeEach(async () => {
        testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filesystem-safeguard-'));

        // depth 0 entries (root children)
        await fs.mkdir(path.join(testDir, 'a'));
        await fs.mkdir(path.join(testDir, 'b'));
        await fs.writeFile(path.join(testDir, 'root.txt'), 'root');

        // depth 1
        await fs.mkdir(path.join(testDir, 'a', 'a1'));
        await fs.writeFile(path.join(testDir, 'a', 'file-a.txt'), 'a');
        await fs.writeFile(path.join(testDir, 'b', 'file-b.txt'), 'b');

        // depth 2
        await fs.mkdir(path.join(testDir, 'a', 'a1', 'a2'));
        await fs.writeFile(path.join(testDir, 'a', 'a1', 'file-a1.txt'), 'a1');

        // depth 3
        await fs.writeFile(path.join(testDir, 'a', 'a1', 'a2', 'file-a2.txt'), 'a2');
    });

    afterEach(async () => {
        await fs.rm(testDir, { recursive: true, force: true });
    });

    describe('response shape', () => {
        it('should return { tree, truncated, totalIncluded } when not truncated', async () => {
            const result = await buildTreeForTesting(testDir, testDir);
            expect(result).toHaveProperty('tree');
            expect(result).toHaveProperty('truncated', false);
            expect(result).toHaveProperty('totalIncluded');
            expect(Array.isArray(result.tree)).toBe(true);
            expect(result.totalIncluded).toBeGreaterThan(0);
            expect(result).not.toHaveProperty('reason');
        });

        it('should include reason when truncated', async () => {
            const result = await buildTreeForTesting(testDir, testDir, { maxNodes: 2 });
            expect(result.truncated).toBe(true);
            expect(result.reason).toBe('maxNodes');
            expect(result.totalIncluded).toBe(2);
        });
    });

    describe('maxDepth', () => {
        it('should limit recursion to the specified depth', async () => {
            const result = await buildTreeForTesting(testDir, testDir, { maxDepth: 1 });

            const dirA = result.tree.find(e => e.name === 'a');
            expect(dirA).toBeDefined();
            expect(dirA!.children).toBeDefined();

            const a1 = dirA!.children!.find(e => e.name === 'a1');
            expect(a1).toBeDefined();
            // At depth 1 we hit the limit, so a1's children should be empty
            expect(a1!.children).toEqual([]);
            expect(result.truncated).toBe(false);
        });

        it('maxDepth=0 should show only root children with empty directory children', async () => {
            const result = await buildTreeForTesting(testDir, testDir, { maxDepth: 0 });

            const dirA = result.tree.find(e => e.name === 'a');
            expect(dirA).toBeDefined();
            expect(dirA!.children).toEqual([]);
            expect(result.tree.find(e => e.name === 'root.txt')).toBeDefined();
        });

        it('maxDepth=null should allow unlimited depth', async () => {
            const result = await buildTreeForTesting(testDir, testDir, { maxDepth: null });

            const dirA = result.tree.find(e => e.name === 'a');
            const a1 = dirA!.children!.find(e => e.name === 'a1');
            const a2 = a1!.children!.find(e => e.name === 'a2');
            expect(a2).toBeDefined();
            expect(a2!.children!.find(e => e.name === 'file-a2.txt')).toBeDefined();
        });
    });

    describe('maxNodes', () => {
        it('should truncate when node limit is reached', async () => {
            const result = await buildTreeForTesting(testDir, testDir, { maxNodes: 3 });
            expect(result.truncated).toBe(true);
            expect(result.totalIncluded).toBe(3);
            expect(result.reason).toBe('maxNodes');
        });

        it('should not truncate when within node limit', async () => {
            const result = await buildTreeForTesting(testDir, testDir, { maxNodes: 100 });
            expect(result.truncated).toBe(false);
            expect(result.totalIncluded).toBeGreaterThan(0);
        });

        it('maxNodes=null should allow unlimited nodes', async () => {
            const result = await buildTreeForTesting(testDir, testDir, { maxNodes: null });
            expect(result.truncated).toBe(false);
        });

        it('maxNodes=1 should return exactly one entry', async () => {
            const result = await buildTreeForTesting(testDir, testDir, { maxNodes: 1 });
            expect(result.truncated).toBe(true);
            expect(result.totalIncluded).toBe(1);
        });
    });

    describe('dirsOnly', () => {
        it('should omit files when dirsOnly is true', async () => {
            const result = await buildTreeForTesting(testDir, testDir, {
                dirsOnly: true,
                maxDepth: null,
                maxNodes: null,
            });

            function collectEntries(entries: TreeEntry[]): TreeEntry[] {
                const all: TreeEntry[] = [];
                for (const e of entries) {
                    all.push(e);
                    if (e.children) all.push(...collectEntries(e.children));
                }
                return all;
            }

            const all = collectEntries(result.tree);
            const files = all.filter(e => e.type === 'file');
            const dirs = all.filter(e => e.type === 'directory');

            expect(files).toHaveLength(0);
            expect(dirs.length).toBeGreaterThan(0);
        });

        it('should include files when dirsOnly is false', async () => {
            const result = await buildTreeForTesting(testDir, testDir, { dirsOnly: false });

            function collectEntries(entries: TreeEntry[]): TreeEntry[] {
                const all: TreeEntry[] = [];
                for (const e of entries) {
                    all.push(e);
                    if (e.children) all.push(...collectEntries(e.children));
                }
                return all;
            }

            const all = collectEntries(result.tree);
            const files = all.filter(e => e.type === 'file');
            expect(files.length).toBeGreaterThan(0);
        });
    });

    describe('compact output', () => {
        it('compact=true should produce single-line JSON', () => {
            const data = { tree: [{ name: 'a', type: 'directory', children: [] }], truncated: false, totalIncluded: 1 };
            const compact = JSON.stringify(data);
            expect(compact).not.toContain('\n');
        });

        it('compact=false should produce indented JSON', () => {
            const data = { tree: [{ name: 'a', type: 'directory', children: [] }], truncated: false, totalIncluded: 1 };
            const pretty = JSON.stringify(data, null, 2);
            expect(pretty).toContain('\n');
        });
    });

    describe('default behavior (implicit limits)', () => {
        it('default maxNodes=1000 should not truncate small directories', async () => {
            const result = await buildTreeForTesting(testDir, testDir);
            expect(result.truncated).toBe(false);
            expect(result.totalIncluded).toBeLessThan(1000);
        });

        it('default maxDepth=5 should not truncate shallow directories', async () => {
            const result = await buildTreeForTesting(testDir, testDir);
            expect(result.truncated).toBe(false);
        });
    });

    describe('large directory truncation', () => {
        let largeDir: string;

        beforeEach(async () => {
            largeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filesystem-large-'));
            for (let i = 0; i < 20; i++) {
                await fs.writeFile(path.join(largeDir, `file-${i}.txt`), `content ${i}`);
            }
        });

        afterEach(async () => {
            await fs.rm(largeDir, { recursive: true, force: true });
        });

        it('should truncate at maxNodes for many files', async () => {
            const result = await buildTreeForTesting(largeDir, largeDir, { maxNodes: 10 });
            expect(result.truncated).toBe(true);
            expect(result.totalIncluded).toBe(10);
            expect(result.reason).toBe('maxNodes');
        });
    });
});
