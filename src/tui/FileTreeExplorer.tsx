import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Box, Text } from 'ink';
import fs from 'node:fs';
import path from 'node:path';

export interface FileTreeNode {
  name: string;
  relPath: string;
  fullPath: string;
  isDirectory: boolean;
  children?: FileTreeNode[];
  size?: number;
  depth: number;
}

export interface FlatTreeItem {
  id: string; // relPath
  name: string;
  relPath: string;
  fullPath: string;
  isDirectory: boolean;
  isExpanded: boolean;
  hasChildren: boolean;
  depth: number;
  size?: number;
}

const IGNORED_NAMES = new Set([
  '.git',
  '.venv',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.coverage',
  '.DS_Store',
  'dist',
  'build',
  '.turbo',
  '.next',
]);

/**
 * Recursively scans directory tree excluding internal/noisy folders (.git, .venv, node_modules, etc.)
 */
export function scanWorkspaceTree(rootDir: string, maxDepth = 6): FileTreeNode[] {
  if (!rootDir || !fs.existsSync(rootDir)) return [];

  function scanDir(dir: string, rel = '', depth = 0): FileTreeNode[] {
    if (depth > maxDepth) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const dirs: FileTreeNode[] = [];
    const files: FileTreeNode[] = [];

    for (const ent of entries) {
      if (IGNORED_NAMES.has(ent.name) || ent.name.endsWith('.egg-info')) {
        continue;
      }

      const itemRel = rel ? `${rel}/${ent.name}` : ent.name;
      const fullPath = path.join(dir, ent.name);

      if (ent.isDirectory()) {
        const children = scanDir(fullPath, itemRel, depth + 1);
        dirs.push({
          name: ent.name,
          relPath: itemRel,
          fullPath,
          isDirectory: true,
          children,
          depth,
        });
      } else {
        let size = 0;
        try {
          size = fs.statSync(fullPath).size;
        } catch {
          // ignore stat errors
        }
        files.push({
          name: ent.name,
          relPath: itemRel,
          fullPath,
          isDirectory: false,
          size,
          depth,
        });
      }
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

  return scanDir(rootDir);
}

/**
 * Collects all directory relative paths to expand all nodes.
 */
export function getAllDirectoryPaths(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  function collect(list: FileTreeNode[]) {
    for (const n of list) {
      if (n.isDirectory) {
        paths.push(n.relPath);
        if (n.children) collect(n.children);
      }
    }
  }
  collect(nodes);
  return paths;
}

/**
 * Returns initial expanded paths (auto-expanding repos/ and the primary repo).
 */
export function getInitialExpandedPaths(nodes: FileTreeNode[]): Set<string> {
  const expanded = new Set<string>();
  for (const n of nodes) {
    if (n.isDirectory) {
      expanded.add(n.relPath);
      if (n.name === 'repos' && n.children) {
        for (const repo of n.children) {
          if (repo.isDirectory) {
            expanded.add(repo.relPath);
          }
        }
      }
    }
  }
  return expanded;
}

/**
 * Flattens tree nodes into a linear list according to expanded state.
 */
export function flattenTree(
  nodes: FileTreeNode[],
  expandedPaths: Set<string>,
): FlatTreeItem[] {
  const result: FlatTreeItem[] = [];

  function walk(list: FileTreeNode[]) {
    for (const node of list) {
      const isExpanded = expandedPaths.has(node.relPath);
      const hasChildren = Boolean(node.children && node.children.length > 0);

      result.push({
        id: node.relPath,
        name: node.name,
        relPath: node.relPath,
        fullPath: node.fullPath,
        isDirectory: node.isDirectory,
        isExpanded,
        hasChildren,
        depth: node.depth,
        size: node.size,
      });

      if (node.isDirectory && isExpanded && node.children) {
        walk(node.children);
      }
    }
  }

  walk(nodes);
  return result;
}

/**
 * Formats bytes into a human readable short string.
 */
export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/**
 * Determines file icon and syntax color based on extension.
 */
export function getFileIconAndColor(name: string, isDirectory: boolean): {
  icon: string;
  color: string;
} {
  if (isDirectory) {
    return { icon: '📁', color: 'yellow' };
  }

  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case '.py':
      return { icon: '🐍', color: 'green' };
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
      return { icon: '📄', color: 'cyan' };
    case '.json':
    case '.toml':
    case '.yaml':
    case '.yml':
    case '.env':
    case '.ini':
      return { icon: '⚙', color: 'magenta' };
    case '.sh':
    case '.bash':
    case '.zsh':
      return { icon: '⚡', color: 'green' };
    case '.md':
    case '.txt':
    case '.rst':
      return { icon: '📝', color: 'blue' };
    case '.db':
    case '.sqlite':
    case '.sqlite3':
      return { icon: '🗄', color: 'red' };
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.svg':
      return { icon: '🖼', color: 'magenta' };
    default:
      return { icon: '📄', color: 'white' };
  }
}

export interface UseFileTreeReturn {
  treeNodes: FileTreeNode[];
  flatItems: FlatTreeItem[];
  expandedPaths: Set<string>;
  selectedIndex: number;
  selectedItem: FlatTreeItem | null;
  scrollOffset: number;
  expandAll: () => void;
  collapseAll: () => void;
  toggleSelected: () => void;
  togglePath: (relPath: string) => void;
  navigateUp: () => void;
  navigateDown: () => void;
  collapseOrParent: () => void;
  expandOrDescend: () => void;
  setSelectedIndex: (idx: number) => void;
  scrollUp: (lines?: number) => void;
  scrollDown: (lines?: number) => void;
  refresh: () => void;
  totalFiles: number;
  totalDirs: number;
}

/**
 * Custom React hook managing the file tree state and keyboard actions.
 */
export function useFileTree(
  workspaceDir: string,
  viewportHeight = 24,
): UseFileTreeReturn {
  const [version, setVersion] = useState(0);

  const treeNodes = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _v = version;
    return scanWorkspaceTree(workspaceDir);
  }, [workspaceDir, version]);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() =>
    getInitialExpandedPaths(treeNodes),
  );

  // When workspaceDir changes, re-initialize expanded paths
  useEffect(() => {
    setExpandedPaths(getInitialExpandedPaths(treeNodes));
    setSelectedIndex(0);
  }, [workspaceDir, treeNodes]);

  const flatItems = useMemo(
    () => flattenTree(treeNodes, expandedPaths),
    [treeNodes, expandedPaths],
  );

  const [selectedIndex, setSelectedIndex] = useState(0);

  // Bounds check selected index
  useEffect(() => {
    if (selectedIndex >= flatItems.length) {
      setSelectedIndex(Math.max(0, flatItems.length - 1));
    }
  }, [flatItems.length, selectedIndex]);

  const selectedItem = flatItems[selectedIndex] ?? null;

  // Auto-scroll offset calculation
  const scrollOffset = useMemo(() => {
    const maxVisible = Math.max(5, viewportHeight - 6);
    if (flatItems.length <= maxVisible) return 0;
    if (selectedIndex < maxVisible) return 0;
    return Math.min(
      flatItems.length - maxVisible,
      Math.max(0, selectedIndex - Math.floor(maxVisible / 2)),
    );
  }, [selectedIndex, flatItems.length, viewportHeight]);

  const expandAll = useCallback(() => {
    const all = getAllDirectoryPaths(treeNodes);
    setExpandedPaths(new Set(all));
  }, [treeNodes]);

  const collapseAll = useCallback(() => {
    setExpandedPaths(new Set());
    setSelectedIndex(0);
  }, []);

  const togglePath = useCallback((relPath: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) {
        next.delete(relPath);
      } else {
        next.add(relPath);
      }
      return next;
    });
  }, []);

  const toggleSelected = useCallback(() => {
    const cur = flatItems[selectedIndex];
    if (!cur) return;
    if (cur.isDirectory) {
      togglePath(cur.relPath);
    }
  }, [flatItems, selectedIndex, togglePath]);

  const navigateUp = useCallback(() => {
    setSelectedIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const navigateDown = useCallback(() => {
    setSelectedIndex((prev) => Math.min(flatItems.length - 1, prev + 1));
  }, [flatItems.length]);

  const collapseOrParent = useCallback(() => {
    const cur = flatItems[selectedIndex];
    if (!cur) return;
    if (cur.isDirectory && cur.isExpanded) {
      // Collapse current directory
      togglePath(cur.relPath);
    } else {
      // Find parent directory
      const parts = cur.relPath.split('/');
      if (parts.length > 1) {
        parts.pop();
        const parentRel = parts.join('/');
        const parentIdx = flatItems.findIndex((it) => it.relPath === parentRel);
        if (parentIdx >= 0) {
          setSelectedIndex(parentIdx);
        }
      }
    }
  }, [flatItems, selectedIndex, togglePath]);

  const expandOrDescend = useCallback(() => {
    const cur = flatItems[selectedIndex];
    if (!cur) return;
    if (cur.isDirectory) {
      if (!cur.isExpanded) {
        togglePath(cur.relPath);
      } else if (selectedIndex + 1 < flatItems.length) {
        setSelectedIndex(selectedIndex + 1);
      }
    }
  }, [flatItems, selectedIndex, togglePath]);

  const scrollUp = useCallback((lines = 3) => {
    setSelectedIndex((prev) => Math.max(0, prev - lines));
  }, []);

  const scrollDown = useCallback(
    (lines = 3) => {
      setSelectedIndex((prev) => Math.min(flatItems.length - 1, prev + lines));
    },
    [flatItems.length],
  );

  const refresh = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);

  const { totalFiles, totalDirs } = useMemo(() => {
    let files = 0;
    let dirs = 0;
    function count(list: FileTreeNode[]) {
      for (const n of list) {
        if (n.isDirectory) {
          dirs++;
          if (n.children) count(n.children);
        } else {
          files++;
        }
      }
    }
    count(treeNodes);
    return { totalFiles: files, totalDirs: dirs };
  }, [treeNodes]);

  return {
    treeNodes,
    flatItems,
    expandedPaths,
    selectedIndex,
    selectedItem,
    scrollOffset,
    expandAll,
    collapseAll,
    toggleSelected,
    togglePath,
    navigateUp,
    navigateDown,
    collapseOrParent,
    expandOrDescend,
    setSelectedIndex,
    scrollUp,
    scrollDown,
    refresh,
    totalFiles,
    totalDirs,
  };
}

export interface FileTreeExplorerProps {
  state: UseFileTreeReturn;
  width: number;
  height: number;
  language?: 'es' | 'en';
  onSelectFile?: (item: FlatTreeItem) => void;
}

/**
 * High-performance, interactive file tree explorer pane for the PO CLI TUI.
 */
export const FileTreeExplorer: React.FC<FileTreeExplorerProps> = ({
  state,
  width,
  height,
  language = 'es',
}) => {
  const isEs = language === 'es';
  const effectiveWidth = Math.max(22, width);
  const effectiveHeight = Math.max(8, height);

  // Available rows for the tree items list
  // Header: 2 lines ([EXPLORER] + [Collapse All] [Expand All])
  // Separator: 1 line
  // Footer: 2 lines (stats + help hint)
  const listHeight = Math.max(3, effectiveHeight - 5);

  const visibleItems = state.flatItems.slice(
    state.scrollOffset,
    state.scrollOffset + listHeight,
  );

  return (
    <Box
      flexDirection="column"
      width={effectiveWidth}
      height={effectiveHeight}
      borderStyle="round"
      borderColor="cyan"
      flexShrink={0}
    >
      {/* 1. Header Title */}
      <Box
        flexDirection="row"
        justifyContent="space-between"
        paddingX={1}
        flexShrink={0}
      >
        <Text color="cyan" bold>
          📁 {isEs ? 'EXPLORADOR DE REPOSITORIO' : 'REPOSITORY EXPLORER'}
        </Text>
        <Text dimColor>
          [Shift-T / Esc]
        </Text>
      </Box>

      {/* 2. Action Buttons Bar (Collapse All / Expand All / Resize) */}
      <Box
        flexDirection="row"
        justifyContent="space-between"
        paddingX={1}
        marginTop={0}
        marginBottom={0}
        flexShrink={0}
      >
        <Text color="gray">
          [<Text color="cyan" bold>C</Text> {isEs ? 'Colapsar' : 'Collapse'}]
        </Text>
        <Text color="gray">
          [<Text color="cyan" bold>E</Text> {isEs ? 'Expandir' : 'Expand'}]
        </Text>
        <Text color="gray">
          [<Text color="cyan" bold>+/-</Text> {isEs ? 'Ancho' : 'Width'}]
        </Text>
      </Box>

      <Box
        borderStyle="single"
        borderTop={true}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor="gray"
        width="100%"
      />

      {/* 3. Tree Nodes List Viewport */}
      <Box
        flexDirection="column"
        height={listHeight}
        width="100%"
        overflowY="hidden"
        flexGrow={1}
      >
        {state.flatItems.length === 0 ? (
          <Box paddingX={1} paddingY={1}>
            <Text dimColor>
              {isEs ? '(Repositorio vacío o no creado)' : '(Empty repository)'}
            </Text>
          </Box>
        ) : (
          visibleItems.map((item, vIdx) => {
            const actualIdx = state.scrollOffset + vIdx;
            const isSelected = actualIdx === state.selectedIndex;
            const { icon, color } = getFileIconAndColor(item.name, item.isDirectory);

            // Indentation (2 spaces per depth level)
            const indentSpaces = '  '.repeat(item.depth);

            // Directory expand/collapse indicator arrow
            const arrow = item.isDirectory
              ? item.isExpanded
                ? '▼ '
                : '▶ '
              : '  ';

            const displayName = item.isDirectory ? `${item.name}/` : item.name;
            const sizeStr = formatFileSize(item.size);

            // Max name width calculation
            const reserved = 3 + indentSpaces.length + arrow.length + (sizeStr ? sizeStr.length + 1 : 0);
            const maxNameLen = Math.max(6, effectiveWidth - reserved - 2);
            const truncatedName =
              displayName.length > maxNameLen
                ? `${displayName.slice(0, maxNameLen - 1)}…`
                : displayName;

            const bg = isSelected ? 'blue' : undefined;

            return (
              <Box
                key={item.id}
                flexDirection="row"
                width="100%"
                paddingX={1}
              >
                <Text color={isSelected ? 'white' : 'gray'} backgroundColor={bg} bold={isSelected}>
                  {isSelected ? '> ' : '  '}
                </Text>
                <Text backgroundColor={bg}>{indentSpaces}</Text>
                {item.isDirectory ? (
                  <Text color={isSelected ? 'white' : item.isExpanded ? 'cyan' : 'gray'} bold backgroundColor={bg}>
                    {arrow}
                  </Text>
                ) : (
                  <Text backgroundColor={bg}>{arrow}</Text>
                )}
                <Text backgroundColor={bg}>{icon} </Text>
                <Text
                  color={isSelected ? 'white' : color}
                  bold={item.isDirectory || isSelected}
                  backgroundColor={bg}
                >
                  {truncatedName}
                </Text>
                {sizeStr && !item.isDirectory ? (
                  <Box flexGrow={1} justifyContent="flex-end">
                    <Text dimColor={!isSelected} color={isSelected ? 'white' : undefined} backgroundColor={bg}>
                      {sizeStr}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            );
          })
        )}
      </Box>

      {/* 4. Footer & Quick Guide */}
      <Box
        borderStyle="single"
        borderTop={true}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor="gray"
        width="100%"
      />
      <Box
        flexDirection="column"
        paddingX={1}
        flexShrink={0}
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>
            {state.totalFiles} {isEs ? 'archivos' : 'files'} · {state.totalDirs} dirs
          </Text>
          {state.selectedItem ? (
            <Text color="cyan">
              {formatFileSize(state.selectedItem.size)}
            </Text>
          ) : null}
        </Box>
        <Text dimColor>
          ↑↓ {isEs ? 'Mover' : 'Nav'} · ↵ {isEs ? 'Abrir' : 'Toggle'} · +/- {isEs ? 'Ancho' : 'Width'} · Esc {isEs ? 'Cerrar' : 'Close'}
        </Text>
      </Box>
    </Box>
  );
};
