<?php
require_once __DIR__ . '/_storage.php';
/**
 * PHP Migration / Port System
 * Place this file in the SOURCE directory. It will detect sibling directories
 * as potential migration targets and provide a side-by-side comparison UI.
 */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('memory_limit', '512M');
ini_set('max_execution_time', '120');

// --- Configuration ---
define('SOURCE_DIR', realpath(__DIR__));
define('PARENT_DIR', realpath(dirname(__DIR__)));
define('CONFIG_FILE', __DIR__ . DIRECTORY_SEPARATOR . '.port_config.json');

/**
 * Read persisted config from JSON file.
 */
function readConfig(): array {
    if (!file_exists(CONFIG_FILE)) return ['skipped_dirs' => []];
    $raw = @file_get_contents(CONFIG_FILE);
    if ($raw === false) return ['skipped_dirs' => []];
    $data = json_decode($raw, true);
    if (!is_array($data)) return ['skipped_dirs' => []];
    if (!isset($data['skipped_dirs']) || !is_array($data['skipped_dirs'])) {
        $data['skipped_dirs'] = [];
    }
    return $data;
}

/**
 * Write config to JSON file.
 */
function writeConfig(array $config): bool {
    $json = json_encode($config, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    return @file_put_contents(CONFIG_FILE, $json) !== false;
}

/**
 * Get all top-level directories in source, with their skip status.
 */
function getSourceTopDirs(): array {
    $config = readConfig();
    $skipped = array_flip($config['skipped_dirs']);
    $dirs = [];

    $entries = @scandir(SOURCE_DIR);
    if ($entries === false) return [];

    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..' || $entry[0] === '.') continue;
        if (is_dir(SOURCE_DIR . DIRECTORY_SEPARATOR . $entry)) {
            $dirs[] = [
                'name' => $entry,
                'skipped' => isset($skipped[$entry]),
            ];
        }
    }

    usort($dirs, function($a, $b) { return strcasecmp($a['name'], $b['name']); });
    return $dirs;
}

// --- Helper Functions ---

/**
 * Get all sibling directories (directories at the same level as this script's directory)
 */
function getSiblingDirectories(): array {
    $siblings = [];
    $parentDir = PARENT_DIR;
    if (!$parentDir || !is_dir($parentDir)) return $siblings;

    $entries = scandir($parentDir);
    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $fullPath = $parentDir . DIRECTORY_SEPARATOR . $entry;
        if (is_dir($fullPath) && realpath($fullPath) !== SOURCE_DIR) {
            $siblings[] = [
                'name' => $entry,
                'path' => realpath($fullPath),
            ];
        }
    }
    sort($siblings);
    return $siblings;
}

/**
 * Recursively list all files and folders in a directory.
 * Returns a nested structure for the tree view.
 */
function getDirectoryTree(string $basePath, string $relativePath = '', array $excludeDirs = []): array {
    $fullPath = $basePath . ($relativePath ? DIRECTORY_SEPARATOR . $relativePath : '');
    if (!is_dir($fullPath)) return [];

    $items = [];
    $entries = @scandir($fullPath);
    if ($entries === false) return [];

    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $entryRelPath = $relativePath ? $relativePath . DIRECTORY_SEPARATOR . $entry : $entry;
        $entryFullPath = $basePath . DIRECTORY_SEPARATOR . $entryRelPath;

        if (is_dir($entryFullPath)) {
            // Check if this top-level directory is excluded
            $topLevel = explode(DIRECTORY_SEPARATOR, $entryRelPath)[0];
            $isExcluded = in_array($topLevel, $excludeDirs, true);

            $items[] = [
                'type' => 'dir',
                'name' => $entry,
                'path' => $entryRelPath,
                'excluded' => $isExcluded,
                'children' => $isExcluded ? [] : getDirectoryTree($basePath, $entryRelPath, $excludeDirs),
            ];
        } else {
            $items[] = [
                'type' => 'file',
                'name' => $entry,
                'path' => $entryRelPath,
                'size' => @filesize($entryFullPath),
                'modified' => @filemtime($entryFullPath),
            ];
        }
    }

    // Sort: directories first, then files, alphabetical within each
    usort($items, function($a, $b) {
        if ($a['type'] !== $b['type']) return $a['type'] === 'dir' ? -1 : 1;
        return strcasecmp($a['name'], $b['name']);
    });

    return $items;
}

/**
 * Get a flat list of all relative file paths in a directory.
 */
function getFlatFileList(string $basePath, string $relativePath = '', array $excludeDirs = []): array {
    $fullPath = $basePath . ($relativePath ? DIRECTORY_SEPARATOR . $relativePath : '');
    if (!is_dir($fullPath)) return [];

    $files = [];
    $entries = @scandir($fullPath);
    if ($entries === false) return [];

    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $entryRelPath = $relativePath ? $relativePath . DIRECTORY_SEPARATOR . $entry : $entry;
        $entryFullPath = $basePath . DIRECTORY_SEPARATOR . $entryRelPath;

        if (is_dir($entryFullPath)) {
            // Check if this top-level dir should be excluded
            $topLevel = explode(DIRECTORY_SEPARATOR, $entryRelPath)[0];
            if (in_array($topLevel, $excludeDirs, true)) continue;
            $files = array_merge($files, getFlatFileList($basePath, $entryRelPath, $excludeDirs));
        } else {
            $files[] = $entryRelPath;
        }
    }
    return $files;
}

/**
 * Get a flat list of all relative directory paths.
 */
function getFlatDirList(string $basePath, string $relativePath = '', array $excludeDirs = []): array {
    $fullPath = $basePath . ($relativePath ? DIRECTORY_SEPARATOR . $relativePath : '');
    if (!is_dir($fullPath)) return [];

    $dirs = [];
    $entries = @scandir($fullPath);
    if ($entries === false) return [];

    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $entryRelPath = $relativePath ? $relativePath . DIRECTORY_SEPARATOR . $entry : $entry;
        $entryFullPath = $basePath . DIRECTORY_SEPARATOR . $entryRelPath;

        if (is_dir($entryFullPath)) {
            $topLevel = explode(DIRECTORY_SEPARATOR, $entryRelPath)[0];
            if (in_array($topLevel, $excludeDirs, true)) continue;
            $dirs[] = $entryRelPath;
            $dirs = array_merge($dirs, getFlatDirList($basePath, $entryRelPath, $excludeDirs));
        }
    }
    return $dirs;
}

/**
 * Quick-check if two directories have mismatched content.
 * Uses early-exit: stops at the FIRST difference found.
 * Returns: ['match' => bool, 'reason' => string|null, 'first_diff' => string|null]
 */
function quickCompareDirectories(string $sourceBase, string $destBase, string $relativePath): array {
    $srcPath = $sourceBase . DIRECTORY_SEPARATOR . $relativePath;
    $dstPath = $destBase . DIRECTORY_SEPARATOR . $relativePath;

    $srcExists = is_dir($srcPath);
    $dstExists = is_dir($dstPath);

    if (!$srcExists && !$dstExists) return ['match' => true, 'reason' => null, 'first_diff' => null];
    if (!$srcExists) return ['match' => false, 'reason' => 'only_in_dest', 'first_diff' => $relativePath];
    if (!$dstExists) return ['match' => false, 'reason' => 'only_in_source', 'first_diff' => $relativePath];

    // Both exist — scan for first mismatch
    $srcEntries = @scandir($srcPath);
    $dstEntries = @scandir($dstPath);
    if ($srcEntries === false) $srcEntries = ['.', '..'];
    if ($dstEntries === false) $dstEntries = ['.', '..'];

    $srcSet = array_flip(array_diff($srcEntries, ['.', '..']));
    $dstSet = array_flip(array_diff($dstEntries, ['.', '..']));

    // Check for files/dirs in source not in dest
    foreach ($srcSet as $name => $_) {
        if (!isset($dstSet[$name])) {
            return [
                'match' => false,
                'reason' => 'missing_in_dest',
                'first_diff' => $relativePath . DIRECTORY_SEPARATOR . $name,
            ];
        }
    }

    // Check for files/dirs in dest not in source
    foreach ($dstSet as $name => $_) {
        if (!isset($srcSet[$name])) {
            return [
                'match' => false,
                'reason' => 'missing_in_source',
                'first_diff' => $relativePath . DIRECTORY_SEPARATOR . $name,
            ];
        }
    }

    // Both have the same entries — check files for modification differences
    foreach ($srcSet as $name => $_) {
        $srcFile = $srcPath . DIRECTORY_SEPARATOR . $name;
        $dstFile = $dstPath . DIRECTORY_SEPARATOR . $name;

        $srcIsDir = is_dir($srcFile);
        $dstIsDir = is_dir($dstFile);

        // Type mismatch (one is file, other is dir)
        if ($srcIsDir !== $dstIsDir) {
            return [
                'match' => false,
                'reason' => 'type_mismatch',
                'first_diff' => $relativePath . DIRECTORY_SEPARATOR . $name,
            ];
        }

        // Compare files by size + mtime
        if (!$srcIsDir) {
            $srcSize = @filesize($srcFile);
            $dstSize = @filesize($dstFile);
            $srcMtime = @filemtime($srcFile);
            $dstMtime = @filemtime($dstFile);

            if ($srcSize !== $dstSize || $srcMtime !== $dstMtime) {
                return [
                    'match' => false,
                    'reason' => 'file_modified',
                    'first_diff' => $relativePath . DIRECTORY_SEPARATOR . $name,
                ];
            }
        }
    }

    return ['match' => true, 'reason' => null, 'first_diff' => null];
}

/**
 * Build the full comparison result between source and destination.
 */
function compareDirectories(string $sourceDir, string $destDir, array $excludeDirs = []): array {
    $sourceFiles = getFlatFileList($sourceDir, '', $excludeDirs);
    $destFiles = getFlatFileList($destDir, '', $excludeDirs);
    $sourceDirs = getFlatDirList($sourceDir, '', $excludeDirs);
    $destDirs = getFlatDirList($destDir, '', $excludeDirs);

    $sourceFileSet = array_flip($sourceFiles);
    $destFileSet = array_flip($destFiles);
    $sourceDirSet = array_flip($sourceDirs);
    $destDirSet = array_flip($destDirs);

    // Files only in source
    $onlyInSource = [];
    foreach ($sourceFiles as $f) {
        if (!isset($destFileSet[$f])) $onlyInSource[] = $f;
    }

    // Files only in dest
    $onlyInDest = [];
    foreach ($destFiles as $f) {
        if (!isset($sourceFileSet[$f])) $onlyInDest[] = $f;
    }

    // Dirs only in source
    $dirsOnlyInSource = [];
    foreach ($sourceDirs as $d) {
        if (!isset($destDirSet[$d])) $dirsOnlyInSource[] = $d;
    }

    // Dirs only in dest
    $dirsOnlyInDest = [];
    foreach ($destDirs as $d) {
        if (!isset($sourceDirSet[$d])) $dirsOnlyInDest[] = $d;
    }

    // Shared directories — quick compare for mismatches
    $mismatchedDirs = [];
    $matchedDirs = [];
    foreach ($sourceDirs as $d) {
        if (isset($destDirSet[$d])) {
            // Only compare top-level shared dirs to avoid redundant nested checks
            // Skip if a parent dir is already flagged
            $isNested = false;
            foreach ($mismatchedDirs as $mm) {
                if (strpos($d, $mm['path'] . DIRECTORY_SEPARATOR) === 0) {
                    $isNested = true;
                    break;
                }
            }
            if ($isNested) continue;

            $cmp = quickCompareDirectories($sourceDir, $destDir, $d);
            if (!$cmp['match']) {
                $mismatchedDirs[] = [
                    'path' => $d,
                    'reason' => $cmp['reason'],
                    'first_diff' => $cmp['first_diff'],
                ];
            } else {
                $matchedDirs[] = $d;
            }
        }
    }

    // Modified files (exist in both but different)
    // For small text/code files: compare by content hash (md5)
    // For large or binary files: compare by size + mtime
    $modifiedFiles = [];
    $codeExts = ['php','html','htm','css','js','json','xml','txt','md','yml','yaml',
                 'ini','cfg','conf','sh','bash','sql','csv','log','env','htaccess',
                 'gitignore','twig','blade','vue','jsx','tsx','ts','py','rb','java',
                 'c','cpp','h','hpp','go','rs','swift','kt','scss','sass','less',
                 'toml','lock','map','svg'];
    $maxContentCompareSize = 2 * 1024 * 1024; // 2MB limit for content compare

    foreach ($sourceFiles as $f) {
        if (isset($destFileSet[$f])) {
            $srcFile = $sourceDir . DIRECTORY_SEPARATOR . $f;
            $dstFile = $destDir . DIRECTORY_SEPARATOR . $f;
            $srcSize = @filesize($srcFile);
            $dstSize = @filesize($dstFile);
            $srcMtime = @filemtime($srcFile);
            $dstMtime = @filemtime($dstFile);

            $ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
            $isCodeFile = in_array($ext, $codeExts, true);
            $isSmallEnough = $srcSize <= $maxContentCompareSize && $dstSize <= $maxContentCompareSize;

            if ($isCodeFile && $isSmallEnough) {
                // Content-based comparison for code/text files
                $srcHash = @md5_file($srcFile);
                $dstHash = @md5_file($dstFile);
                if ($srcHash !== false && $dstHash !== false && $srcHash !== $dstHash) {
                    $modifiedFiles[] = [
                        'path' => $f,
                        'source_size' => $srcSize,
                        'dest_size' => $dstSize,
                        'source_mtime' => $srcMtime,
                        'dest_mtime' => $dstMtime,
                        'method' => 'content',
                    ];
                }
            } else {
                // Fallback: size + mtime comparison for binary/large files
                if ($srcSize !== $dstSize || $srcMtime !== $dstMtime) {
                    $modifiedFiles[] = [
                        'path' => $f,
                        'source_size' => $srcSize,
                        'dest_size' => $dstSize,
                        'source_mtime' => $srcMtime,
                        'dest_mtime' => $dstMtime,
                        'method' => 'meta',
                    ];
                }
            }
        }
    }

    return [
        'source_file_count' => count($sourceFiles),
        'dest_file_count' => count($destFiles),
        'source_dir_count' => count($sourceDirs),
        'dest_dir_count' => count($destDirs),
        'only_in_source' => $onlyInSource,
        'only_in_dest' => $onlyInDest,
        'dirs_only_in_source' => $dirsOnlyInSource,
        'dirs_only_in_dest' => $dirsOnlyInDest,
        'mismatched_dirs' => $mismatchedDirs,
        'matched_dirs' => $matchedDirs,
        'modified_files' => $modifiedFiles,
    ];
}

/**
 * Format file size to human readable.
 */
function formatSize(int $bytes): string {
    if ($bytes < 1024) return $bytes . ' B';
    if ($bytes < 1048576) return round($bytes / 1024, 1) . ' KB';
    if ($bytes < 1073741824) return round($bytes / 1048576, 1) . ' MB';
    return round($bytes / 1073741824, 2) . ' GB';
}

/**
 * Get file content for preview (text files only).
 */
function getFilePreview(string $path, int $maxBytes = 8192): ?string {
    if (!is_file($path) || !is_readable($path)) return null;
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    $textExts = ['php','html','htm','css','js','json','xml','txt','md','yml','yaml',
                 'ini','cfg','conf','sh','bash','sql','csv','log','env','htaccess',
                 'gitignore','twig','blade','vue','jsx','tsx','ts','py','rb','java',
                 'c','cpp','h','hpp','go','rs','swift','kt','scss','sass','less'];
    if (!in_array($ext, $textExts) && $ext !== '') return null;

    $content = @file_get_contents($path, false, null, 0, $maxBytes);
    if ($content === false) return null;
    if (!mb_check_encoding($content, 'UTF-8')) return '[Binary file - preview not available]';
    return $content;
}

define('BACKUP_DIR', PARENT_DIR . DIRECTORY_SEPARATOR . '_port_backups');

/**
 * Recursively create a directory if it doesn't exist.
 */
function ensureDir(string $path): bool {
    if (is_dir($path)) return true;
    return @mkdir($path, 0755, true);
}

/**
 * Execute the port operation.
 * $files: array of relative file paths to copy from source to dest.
 * Returns a manifest array describing everything that was done.
 */
function executePort(string $sourceDir, string $destDir, array $files): array {
    $timestamp = date('Y-m-d_His');
    $portId = 'port_' . $timestamp;
    $backupRoot = BACKUP_DIR . DIRECTORY_SEPARATOR . $portId;
    $backupFilesDir = $backupRoot . DIRECTORY_SEPARATOR . 'backed_up_files';

    // Create backup directory
    if (!ensureDir($backupRoot)) {
        return ['error' => 'Failed to create backup directory: ' . $backupRoot];
    }

    $operations = [];
    $dirsCreated = [];
    $errors = [];

    foreach ($files as $relPath) {
        // Sanitize
        $relPath = str_replace(['..', "\0"], '', $relPath);
        if (empty($relPath)) continue;

        $srcFile = $sourceDir . DIRECTORY_SEPARATOR . $relPath;

        // Source could be a directory name — skip, we handle files only
        if (is_dir($srcFile)) continue;

        if (!is_file($srcFile)) {
            $errors[] = ['file' => $relPath, 'error' => 'Source file not found'];
            continue;
        }

        $dstFile = $destDir . DIRECTORY_SEPARATOR . $relPath;
        $dstDir2 = dirname($dstFile);

        // Track whether dest file already exists
        $destExists = is_file($dstFile);

        // If destination file exists, back it up
        if ($destExists) {
            $backupFile = $backupFilesDir . DIRECTORY_SEPARATOR . $relPath;
            $backupFileDir = dirname($backupFile);
            if (!ensureDir($backupFileDir)) {
                $errors[] = ['file' => $relPath, 'error' => 'Failed to create backup subdirectory'];
                continue;
            }
            if (!@copy($dstFile, $backupFile)) {
                $errors[] = ['file' => $relPath, 'error' => 'Failed to back up destination file'];
                continue;
            }

            // Record overwrite operation
            $operations[] = [
                'type' => 'overwrite',
                'file' => $relPath,
                'backup_path' => 'backed_up_files' . DIRECTORY_SEPARATOR . $relPath,
                'original_size' => @filesize($dstFile),
                'original_mtime' => @filemtime($dstFile),
                'original_md5' => @md5_file($dstFile),
                'new_size' => @filesize($srcFile),
                'new_md5' => @md5_file($srcFile),
            ];
        } else {
            // Record copy-new operation
            $operations[] = [
                'type' => 'copy_new',
                'file' => $relPath,
                'size' => @filesize($srcFile),
                'md5' => @md5_file($srcFile),
            ];
        }

        // Ensure destination directory exists
        if (!is_dir($dstDir2)) {
            if (ensureDir($dstDir2)) {
                // Track created directories so restore can remove them
                $dirsCreated[] = $dstDir2;
            } else {
                $errors[] = ['file' => $relPath, 'error' => 'Failed to create destination directory'];
                continue;
            }
        }

        // Copy source → destination
        if (!@copy($srcFile, $dstFile)) {
            $errors[] = ['file' => $relPath, 'error' => 'Failed to copy file to destination'];
            continue;
        }

        // Preserve modification time
        @touch($dstFile, filemtime($srcFile));
    }

    // Calculate dirs created relative to destDir for clean restore
    $dirsCreatedRelative = [];
    $destDirNorm = rtrim($destDir, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
    foreach ($dirsCreated as $d) {
        $dNorm = rtrim($d, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
        if (strpos($dNorm, $destDirNorm) === 0) {
            $rel = rtrim(substr($dNorm, strlen($destDirNorm)), DIRECTORY_SEPARATOR);
            if ($rel !== '') $dirsCreatedRelative[] = $rel;
        }
    }
    // Sort deepest first so restore can rmdir leaf-to-root
    usort($dirsCreatedRelative, function($a, $b) {
        return substr_count($b, DIRECTORY_SEPARATOR) - substr_count($a, DIRECTORY_SEPARATOR);
    });

    $overwriteCount = 0;
    $newCount = 0;
    foreach ($operations as $op) {
        if ($op['type'] === 'overwrite') $overwriteCount++;
        else $newCount++;
    }

    // Build manifest
    $manifest = [
        'id' => $portId,
        'timestamp' => date('c'),
        'timestamp_human' => date('Y-m-d H:i:s'),
        'source_dir' => $sourceDir,
        'source_name' => basename($sourceDir),
        'dest_dir' => $destDir,
        'dest_name' => basename($destDir),
        'operations' => $operations,
        'dirs_created' => $dirsCreatedRelative,
        'errors' => $errors,
        'summary' => [
            'files_copied_new' => $newCount,
            'files_overwritten' => $overwriteCount,
            'dirs_created' => count($dirsCreatedRelative),
            'total_operations' => count($operations),
            'error_count' => count($errors),
        ],
    ];

    // Write manifest
    $manifestPath = $backupRoot . DIRECTORY_SEPARATOR . 'manifest.json';
    $json = json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    @file_put_contents($manifestPath, $json);

    return $manifest;
}

/**
 * List all available port backups.
 */
function listPortBackups(): array {
    if (!is_dir(BACKUP_DIR)) return [];

    $backups = [];
    $entries = @scandir(BACKUP_DIR);
    if ($entries === false) return [];

    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $manifestPath = BACKUP_DIR . DIRECTORY_SEPARATOR . $entry . DIRECTORY_SEPARATOR . 'manifest.json';
        if (!is_file($manifestPath)) continue;

        $raw = @file_get_contents($manifestPath);
        if ($raw === false) continue;
        $data = json_decode($raw, true);
        if (!is_array($data)) continue;

        $backups[] = [
            'id' => $data['id'] ?? $entry,
            'timestamp' => $data['timestamp'] ?? '',
            'timestamp_human' => $data['timestamp_human'] ?? '',
            'source_name' => $data['source_name'] ?? '?',
            'dest_name' => $data['dest_name'] ?? '?',
            'summary' => $data['summary'] ?? [],
        ];
    }

    // Sort newest first
    usort($backups, function($a, $b) {
        return strcmp($b['timestamp'], $a['timestamp']);
    });

    return $backups;
}

/**
 * Execute a restoration from a backup manifest.
 * This reverses all operations recorded in the manifest.
 */
function executeRestore(string $portId): array {
    $backupRoot = BACKUP_DIR . DIRECTORY_SEPARATOR . $portId;
    $manifestPath = $backupRoot . DIRECTORY_SEPARATOR . 'manifest.json';

    if (!is_file($manifestPath)) {
        return ['error' => 'Manifest not found for: ' . $portId];
    }

    $raw = @file_get_contents($manifestPath);
    $manifest = json_decode($raw, true);
    if (!is_array($manifest)) {
        return ['error' => 'Failed to parse manifest'];
    }

    $destDir = $manifest['dest_dir'];
    if (!is_dir($destDir)) {
        return ['error' => 'Destination directory no longer exists: ' . $destDir];
    }

    $restored = [];
    $deleted = [];
    $errors = [];

    // Process operations in reverse
    $ops = array_reverse($manifest['operations']);
    foreach ($ops as $op) {
        $relPath = $op['file'];
        $dstFile = $destDir . DIRECTORY_SEPARATOR . $relPath;

        if ($op['type'] === 'overwrite') {
            // Restore original file from backup
            $backupFile = $backupRoot . DIRECTORY_SEPARATOR . $op['backup_path'];
            if (!is_file($backupFile)) {
                $errors[] = ['file' => $relPath, 'error' => 'Backup file missing'];
                continue;
            }
            if (@copy($backupFile, $dstFile)) {
                // Restore original mtime
                if (isset($op['original_mtime'])) {
                    @touch($dstFile, $op['original_mtime']);
                }
                $restored[] = $relPath;
            } else {
                $errors[] = ['file' => $relPath, 'error' => 'Failed to restore from backup'];
            }
        } elseif ($op['type'] === 'copy_new') {
            // This file was new — delete it
            if (is_file($dstFile)) {
                // Verify it's the file we put there
                $currentMd5 = @md5_file($dstFile);
                if ($currentMd5 === ($op['md5'] ?? null)) {
                    if (@unlink($dstFile)) {
                        $deleted[] = $relPath;
                    } else {
                        $errors[] = ['file' => $relPath, 'error' => 'Failed to delete new file'];
                    }
                } else {
                    $errors[] = ['file' => $relPath, 'error' => 'File has been modified since port — skipped delete for safety'];
                }
            }
        }
    }

    // Remove directories that were created (deepest first)
    $dirsRemoved = [];
    if (isset($manifest['dirs_created'])) {
        foreach ($manifest['dirs_created'] as $relDir) {
            $fullDir = $destDir . DIRECTORY_SEPARATOR . $relDir;
            if (is_dir($fullDir)) {
                // Only remove if empty
                $contents = @scandir($fullDir);
                if ($contents !== false && count(array_diff($contents, ['.', '..'])) === 0) {
                    if (@rmdir($fullDir)) {
                        $dirsRemoved[] = $relDir;
                    }
                }
            }
        }
    }

    // Mark manifest as restored
    $manifest['restored'] = true;
    $manifest['restored_at'] = date('c');
    $manifest['restore_log'] = [
        'files_restored' => $restored,
        'files_deleted' => $deleted,
        'dirs_removed' => $dirsRemoved,
        'errors' => $errors,
    ];
    @file_put_contents($manifestPath, json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

    return [
        'ok' => true,
        'files_restored' => count($restored),
        'files_deleted' => count($deleted),
        'dirs_removed' => count($dirsRemoved),
        'errors' => $errors,
    ];
}

// --- AJAX Handlers ---
$action = $_GET['action'] ?? $_POST['action'] ?? null;

if ($action === 'get_siblings') {
    header('Content-Type: application/json');
    echo json_encode(['siblings' => getSiblingDirectories(), 'source' => basename(SOURCE_DIR)]);
    exit;
}

if ($action === 'get_source_dirs') {
    header('Content-Type: application/json');
    echo json_encode(['dirs' => getSourceTopDirs()]);
    exit;
}

if ($action === 'toggle_skip') {
    header('Content-Type: application/json');
    $dirName = $_GET['dir'] ?? '';
    $skip = ($_GET['skip'] ?? '1') === '1';

    if (!$dirName || strpos($dirName, DIRECTORY_SEPARATOR) !== false || strpos($dirName, '..') !== false) {
        echo json_encode(['error' => 'Invalid directory name']);
        exit;
    }

    $config = readConfig();
    $skippedSet = array_flip($config['skipped_dirs']);

    if ($skip) {
        $skippedSet[$dirName] = true;
    } else {
        unset($skippedSet[$dirName]);
    }

    $config['skipped_dirs'] = array_keys($skippedSet);
    sort($config['skipped_dirs']);
    $ok = writeConfig($config);

    echo json_encode(['ok' => $ok, 'skipped_dirs' => $config['skipped_dirs']]);
    exit;
}

if ($action === 'get_tree') {
    header('Content-Type: application/json');
    $which = $_GET['which'] ?? 'source';
    $destName = $_GET['dest'] ?? '';
    $excludeRaw = $_GET['exclude'] ?? '';
    $excludeDirs = $excludeRaw ? explode(',', $excludeRaw) : [];

    try {
        if ($which === 'source') {
            $tree = getDirectoryTree(SOURCE_DIR, '', $excludeDirs);
            echo json_encode(['tree' => $tree, 'base' => basename(SOURCE_DIR)]);
        } else {
            $destPath = PARENT_DIR . DIRECTORY_SEPARATOR . $destName;
            if (!is_dir($destPath) || realpath($destPath) === SOURCE_DIR) {
                echo json_encode(['error' => 'Invalid destination directory']);
            } else {
                $tree = getDirectoryTree(realpath($destPath), '', $excludeDirs);
                echo json_encode(['tree' => $tree, 'base' => $destName]);
            }
        }
    } catch (\Throwable $e) {
        echo json_encode(['error' => 'Tree scan failed: ' . $e->getMessage()]);
    }
    exit;
}

if ($action === 'compare') {
    header('Content-Type: application/json');
    $destName = $_GET['dest'] ?? '';
    $destPath = PARENT_DIR . DIRECTORY_SEPARATOR . $destName;
    $excludeRaw = $_GET['exclude'] ?? '';
    $excludeDirs = $excludeRaw ? explode(',', $excludeRaw) : [];

    if (!is_dir($destPath) || realpath($destPath) === SOURCE_DIR) {
        echo json_encode(['error' => 'Invalid destination directory']);
        exit;
    }

    try {
        $result = compareDirectories(SOURCE_DIR, realpath($destPath), $excludeDirs);
        $result['source_name'] = basename(SOURCE_DIR);
        $result['dest_name'] = $destName;
        $result['excluded'] = $excludeDirs;
        echo json_encode($result);
    } catch (\Throwable $e) {
        echo json_encode(['error' => 'Compare failed: ' . $e->getMessage()]);
    }
    exit;
}

if ($action === 'preview_file') {
    header('Content-Type: application/json');
    $which = $_GET['which'] ?? 'source';
    $filePath = $_GET['file'] ?? '';
    $destName = $_GET['dest'] ?? '';

    // Sanitize path
    $filePath = str_replace(['..', "\0"], '', $filePath);

    if ($which === 'source') {
        $fullPath = SOURCE_DIR . DIRECTORY_SEPARATOR . $filePath;
    } else {
        $destPath = PARENT_DIR . DIRECTORY_SEPARATOR . $destName;
        $fullPath = $destPath . DIRECTORY_SEPARATOR . $filePath;
    }

    $fullPath = realpath($fullPath);
    if (!$fullPath || !is_file($fullPath)) {
        echo json_encode(['error' => 'File not found']);
        exit;
    }

    $content = getFilePreview($fullPath);
    echo json_encode([
        'content' => $content,
        'name' => basename($fullPath),
        'size' => filesize($fullPath),
        'modified' => date('Y-m-d H:i:s', filemtime($fullPath)),
    ]);
    exit;
}

if ($action === 'execute_port') {
    header('Content-Type: application/json');
    // Accept POST with JSON body
    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input)) {
        echo json_encode(['error' => 'Invalid request body']);
        exit;
    }

    $destName = $input['dest'] ?? '';
    $files = $input['files'] ?? [];

    if (empty($destName) || empty($files)) {
        echo json_encode(['error' => 'Missing destination or file list']);
        exit;
    }

    $destPath = PARENT_DIR . DIRECTORY_SEPARATOR . $destName;
    if (!is_dir($destPath) || realpath($destPath) === SOURCE_DIR) {
        echo json_encode(['error' => 'Invalid destination directory']);
        exit;
    }

    try {
        $result = executePort(SOURCE_DIR, realpath($destPath), $files);
        echo json_encode($result);
    } catch (\Throwable $e) {
        echo json_encode(['error' => 'Port failed: ' . $e->getMessage()]);
    }
    exit;
}

if ($action === 'list_backups') {
    header('Content-Type: application/json');
    echo json_encode(['backups' => listPortBackups()]);
    exit;
}

if ($action === 'get_backup') {
    header('Content-Type: application/json');
    $portId = $_GET['id'] ?? '';
    $portId = preg_replace('/[^a-zA-Z0-9_\-]/', '', $portId);

    $manifestPath = BACKUP_DIR . DIRECTORY_SEPARATOR . $portId . DIRECTORY_SEPARATOR . 'manifest.json';
    if (!is_file($manifestPath)) {
        echo json_encode(['error' => 'Backup not found']);
        exit;
    }

    $raw = @file_get_contents($manifestPath);
    $data = json_decode($raw, true);
    echo json_encode($data ?: ['error' => 'Failed to parse manifest']);
    exit;
}

if ($action === 'execute_restore') {
    header('Content-Type: application/json');
    $input = json_decode(file_get_contents('php://input'), true);
    $portId = $input['id'] ?? '';
    $portId = preg_replace('/[^a-zA-Z0-9_\-]/', '', $portId);

    if (empty($portId)) {
        echo json_encode(['error' => 'Missing backup ID']);
        exit;
    }

    try {
        $result = executeRestore($portId);
        echo json_encode($result);
    } catch (\Throwable $e) {
        echo json_encode(['error' => 'Restore failed: ' . $e->getMessage()]);
    }
    exit;
}

// --- Main HTML Output ---
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Port System — Migration Tool</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap');

:root {
    --bg-deep: #0c0e14;
    --bg-panel: #12151e;
    --bg-surface: #181c28;
    --bg-hover: #1e2336;
    --bg-active: #252a3d;
    --border: #2a2f42;
    --border-light: #353b52;
    --text-primary: #e2e5f0;
    --text-secondary: #8b91a8;
    --text-muted: #5a6078;
    --accent-blue: #5b9cf6;
    --accent-blue-dim: #3a6dc4;
    --accent-green: #5ce0a8;
    --accent-green-dim: rgba(92, 224, 168, 0.12);
    --accent-red: #f06a6a;
    --accent-red-dim: rgba(240, 106, 106, 0.12);
    --accent-yellow: #f0c75e;
    --accent-yellow-dim: rgba(240, 199, 94, 0.12);
    --accent-purple: #b08cf6;
    --accent-purple-dim: rgba(176, 140, 246, 0.12);
    --accent-orange: #f0935e;
    --radius: 6px;
    --radius-lg: 10px;
    --mono: 'JetBrains Mono', monospace;
    --sans: 'DM Sans', sans-serif;
    --shadow: 0 2px 12px rgba(0,0,0,0.3);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body {
    height: 100%;
    background: var(--bg-deep);
    color: var(--text-primary);
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.5;
    overflow: hidden;
}

/* --- Scrollbar --- */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--border-light); }

/* --- Layout --- */
.app {
    display: flex;
    flex-direction: column;
    height: 100vh;
}

.topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    gap: 16px;
}

.topbar-left {
    display: flex;
    align-items: center;
    gap: 12px;
}

.logo {
    font-family: var(--mono);
    font-weight: 700;
    font-size: 15px;
    color: var(--accent-blue);
    letter-spacing: -0.5px;
    display: flex;
    align-items: center;
    gap: 8px;
}

.logo-icon {
    width: 28px;
    height: 28px;
    background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    color: #fff;
}

.topbar-info {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-secondary);
}

.path-badge {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 10px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-secondary);
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.dest-selector {
    display: flex;
    align-items: center;
    gap: 8px;
}

.dest-selector label {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.dest-selector select {
    appearance: none;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px 32px 6px 12px;
    color: var(--text-primary);
    font-family: var(--mono);
    font-size: 12px;
    cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%238b91a8' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    outline: none;
    transition: border-color 0.15s;
}

.dest-selector select:hover { border-color: var(--border-light); }
.dest-selector select:focus { border-color: var(--accent-blue); }

.btn {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 500;
    padding: 7px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-surface);
    color: var(--text-primary);
    cursor: pointer;
    transition: all 0.15s;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
}

.btn:hover {
    background: var(--bg-hover);
    border-color: var(--border-light);
}

.btn-primary {
    background: var(--accent-blue);
    border-color: var(--accent-blue);
    color: #fff;
}

.btn-primary:hover {
    background: var(--accent-blue-dim);
}

.btn-port {
    background: linear-gradient(135deg, var(--accent-green), #3ab88a);
    border-color: transparent;
    color: #0c0e14;
    font-weight: 600;
}

.btn-port:hover {
    opacity: 0.9;
}

.btn-port:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

/* --- Main Content --- */
.main-content {
    flex: 1;
    display: flex;
    overflow: hidden;
}

/* --- Panels --- */
.panel-container {
    display: flex;
    flex: 1;
    overflow: hidden;
}

.panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid var(--border);
}

.panel:last-child { border-right: none; }

.panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
}

.panel-title {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    display: flex;
    align-items: center;
    gap: 8px;
}

.panel-title .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.source-dot { background: var(--accent-blue); }
.dest-dot { background: var(--accent-purple); }
.diff-dot { background: var(--accent-yellow); }

.panel-stats {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-muted);
}

.panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
}

/* --- Comparison Center Panel --- */
.comparison-panel {
    flex: 0 0 360px;
    min-width: 320px;
}

.comparison-panel .panel-body {
    padding: 12px;
}

/* --- Tree View --- */
.tree-item {
    display: flex;
    align-items: center;
    padding: 3px 16px 3px 0;
    cursor: pointer;
    transition: background 0.1s;
    user-select: none;
    position: relative;
}

.tree-item:hover { background: var(--bg-hover); }
.tree-item.selected { background: var(--bg-active); }
.tree-item.checked {
    background: rgba(91, 156, 246, 0.10);
    border-left: 2px solid var(--accent-blue);
}
.tree-item.checked:hover {
    background: rgba(91, 156, 246, 0.16);
}
.tree-item.checked .tree-name {
    color: var(--accent-blue);
}

.tree-indent {
    display: inline-block;
    width: 20px;
    flex-shrink: 0;
}

.tree-toggle {
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--text-muted);
    font-size: 10px;
    transition: transform 0.15s;
}

.tree-toggle.open { transform: rotate(90deg); }
.tree-toggle.empty { visibility: hidden; }

.tree-icon {
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-right: 6px;
    font-size: 12px;
}

.tree-icon.dir { color: var(--accent-blue); }
.tree-icon.file { color: var(--text-muted); }

.tree-name {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-primary);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tree-meta {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-muted);
    margin-left: auto;
    padding-left: 12px;
    flex-shrink: 0;
}

.tree-checkbox {
    width: 16px;
    height: 16px;
    margin-right: 8px;
    flex-shrink: 0;
    accent-color: var(--accent-blue);
    cursor: pointer;
}

/* --- Diff Section --- */
.diff-section {
    margin-bottom: 16px;
}

.diff-section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius) var(--radius) 0 0;
    cursor: pointer;
    user-select: none;
    transition: background 0.1s;
}

.diff-section-header:hover { background: var(--bg-hover); }

.diff-section-header .toggle {
    font-size: 10px;
    color: var(--text-muted);
    transition: transform 0.15s;
}

.diff-section-header .toggle.open { transform: rotate(90deg); }

.diff-section-title {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.diff-section-count {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-left: auto;
}

.diff-select-all {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 500;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bg-panel);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.12s;
    white-space: nowrap;
}

.diff-select-all:hover {
    background: rgba(91, 156, 246, 0.15);
    border-color: var(--accent-blue);
    color: var(--accent-blue);
}

.diff-section-body {
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 var(--radius) var(--radius);
    max-height: 240px;
    overflow-y: auto;
}

.diff-item {
    display: flex;
    align-items: center;
    padding: 5px 12px;
    font-family: var(--mono);
    font-size: 11px;
    border-bottom: 1px solid var(--border);
    gap: 8px;
    cursor: pointer;
    transition: background 0.1s;
    user-select: none;
}

.diff-item:hover {
    background: var(--bg-hover);
}

.diff-item.diff-selected {
    background: rgba(91, 156, 246, 0.12);
    border-left: 2px solid var(--accent-blue);
}

.diff-item.diff-selected .diff-path {
    color: var(--accent-blue);
}

.diff-item:last-child { border-bottom: none; }

.diff-badge {
    font-size: 9px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    flex-shrink: 0;
}

.badge-new {
    background: var(--accent-green-dim);
    color: var(--accent-green);
    border: 1px solid rgba(92, 224, 168, 0.25);
}

.badge-missing {
    background: var(--accent-red-dim);
    color: var(--accent-red);
    border: 1px solid rgba(240, 106, 106, 0.25);
}

.badge-modified {
    background: var(--accent-yellow-dim);
    color: var(--accent-yellow);
    border: 1px solid rgba(240, 199, 94, 0.25);
}

.badge-mismatch {
    background: var(--accent-orange);
    color: #0c0e14;
    border: 1px solid transparent;
}

.badge-dir {
    background: var(--accent-purple-dim);
    color: var(--accent-purple);
    border: 1px solid rgba(176, 140, 246, 0.25);
}

.diff-path {
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
}

.diff-detail {
    color: var(--text-muted);
    font-size: 10px;
    flex-shrink: 0;
}

/* --- Summary Stats --- */
.summary-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 16px;
}

.summary-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 12px;
    text-align: center;
}

.summary-card .num {
    font-family: var(--mono);
    font-size: 22px;
    font-weight: 700;
    line-height: 1.2;
}

.summary-card .label {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 2px;
}

.num-green { color: var(--accent-green); }
.num-red { color: var(--accent-red); }
.num-yellow { color: var(--accent-yellow); }
.num-purple { color: var(--accent-purple); }

/* --- File Preview Modal --- */
.modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(4px);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
}

.modal-overlay.visible {
    opacity: 1;
    pointer-events: auto;
}

.modal {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    width: 90%;
    max-width: 800px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 40px rgba(0,0,0,0.5);
    transform: translateY(10px);
    transition: transform 0.2s;
}

.modal-overlay.visible .modal {
    transform: translateY(0);
}

.modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
}

.modal-title {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
}

.modal-meta {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-muted);
}

.modal-close {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: var(--bg-surface);
    color: var(--text-secondary);
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 16px;
    transition: all 0.1s;
}

.modal-close:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
}

.modal-body {
    flex: 1;
    overflow: auto;
    padding: 0;
}

.modal-body pre {
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    padding: 16px 20px;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
}

.modal-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
}

/* --- Port Confirm Content --- */
.confirm-summary {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 8px;
    margin-bottom: 14px;
}

.confirm-stat {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    text-align: center;
}

.confirm-stat .num {
    font-family: var(--mono);
    font-size: 18px;
    font-weight: 700;
    line-height: 1.2;
}

.confirm-stat .label {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
}

.confirm-file-list {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-family: var(--mono);
    font-size: 11px;
}

.confirm-file-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--border);
    color: var(--text-secondary);
}

.confirm-file-item:last-child { border-bottom: none; }

.confirm-warning {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: var(--accent-yellow-dim);
    border: 1px solid rgba(240, 199, 94, 0.3);
    border-radius: var(--radius);
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent-yellow);
    margin-top: 12px;
}

/* --- Result Content --- */
.result-section {
    margin-bottom: 12px;
}

.result-section-title {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    margin-bottom: 6px;
}

.result-op-list {
    max-height: 180px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-family: var(--mono);
    font-size: 11px;
}

.result-op-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--border);
    color: var(--text-secondary);
}

.result-op-item:last-child { border-bottom: none; }

/* --- History Items --- */
.history-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 8px;
    transition: border-color 0.12s;
}

.history-item:hover {
    border-color: var(--border-light);
}

.history-item.restored {
    opacity: 0.5;
}

.history-info {
    flex: 1;
}

.history-title {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 2px;
}

.history-detail {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-muted);
}

.history-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
}

/* --- Empty / Loading States --- */
.empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
    color: var(--text-muted);
    font-family: var(--mono);
    font-size: 12px;
    text-align: center;
    gap: 12px;
}

.empty-state .icon {
    font-size: 32px;
    opacity: 0.4;
}

.spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--border);
    border-top-color: var(--accent-blue);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

/* --- Bottom Status Bar --- */
.statusbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 20px;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-muted);
}

.statusbar-left, .statusbar-right {
    display: flex;
    align-items: center;
    gap: 16px;
}

.status-indicator {
    display: flex;
    align-items: center;
    gap: 5px;
}

.status-indicator .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-green);
}

/* --- Selection Count --- */
.selection-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    background: rgba(91, 156, 246, 0.08);
    border-top: 1px solid rgba(91, 156, 246, 0.2);
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent-blue);
    flex-shrink: 0;
}

.selection-bar .count {
    font-weight: 600;
}

/* --- Inline Skip Toggle on Source Dirs --- */
.skip-toggle {
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    margin-left: auto;
    padding: 0;
    opacity: 0;
    transition: all 0.12s;
}

.tree-item:hover .skip-toggle {
    opacity: 0.6;
}

.tree-item:hover .skip-toggle:hover {
    opacity: 1;
    background: var(--bg-active);
    color: var(--accent-red);
}

.skip-toggle.is-skipped {
    opacity: 1;
    color: var(--accent-red);
}

.tree-item:hover .skip-toggle.is-skipped:hover {
    color: var(--accent-green);
}

.tree-item.skipped-row .tree-toggle,
.tree-item.skipped-row .tree-icon,
.tree-item.skipped-row .tree-name,
.tree-item.skipped-row .tree-checkbox {
    opacity: 0.4;
}

.tree-item.skipped-row:hover {
    background: var(--bg-hover);
    cursor: pointer;
}

.skipped-label {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--accent-red);
    font-style: italic;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--accent-red-dim);
    border: 1px solid rgba(240, 106, 106, 0.2);
    flex-shrink: 0;
}

.hidden { display: none !important; }
</style>
</head>
<body>
<div class="app" id="app">
    <!-- Top Bar -->
    <div class="topbar">
        <div class="topbar-left">
            <div class="logo">
                <div class="logo-icon">⇄</div>
                PORT
            </div>
            <span class="path-badge" id="sourcePath" title="<?= htmlspecialchars(SOURCE_DIR) ?>">
                <?= htmlspecialchars(SOURCE_DIR) ?>
            </span>
        </div>
        <div class="dest-selector">
            <label>Target →</label>
            <select id="destSelect">
                <option value="">Select destination…</option>
            </select>
            <button class="btn btn-primary" id="compareBtn" disabled>Compare</button>
            <button class="btn" id="historyBtn">📋 History</button>
            <button class="btn btn-port" id="portBtn" disabled>⇄ Run Port</button>
        </div>
    </div>

    <!-- Main Content -->
    <div class="main-content">
        <div class="panel-container" id="panelContainer">
            <!-- Source Panel -->
            <div class="panel" id="sourcePanel">
                <div class="panel-header">
                    <div class="panel-title">
                        <span class="dot source-dot"></span>
                        Source — <span id="sourceName"><?= htmlspecialchars(basename(SOURCE_DIR)) ?></span>
                    </div>
                    <div class="panel-stats" id="sourceStats"></div>
                </div>
                <div class="panel-body" id="sourceTree">
                    <div class="empty-state">
                        <div class="spinner"></div>
                        <div>Loading source tree…</div>
                    </div>
                </div>
                <div class="selection-bar hidden" id="sourceSelection">
                    <span><span class="count" id="sourceSelCount">0</span> files selected</span>
                    <button class="btn" onclick="clearSelection('source')" style="padding:3px 10px;font-size:11px;">Clear</button>
                </div>
            </div>

            <!-- Comparison Panel (hidden until compare) -->
            <div class="panel comparison-panel hidden" id="compPanel">
                <div class="panel-header">
                    <div class="panel-title">
                        <span class="dot diff-dot"></span>
                        Comparison
                    </div>
                </div>
                <div class="panel-body" id="compBody">
                </div>
            </div>

            <!-- Destination Panel -->
            <div class="panel" id="destPanel">
                <div class="panel-header">
                    <div class="panel-title">
                        <span class="dot dest-dot"></span>
                        Destination — <span id="destName">None selected</span>
                    </div>
                    <div class="panel-stats" id="destStats"></div>
                </div>
                <div class="panel-body" id="destTree">
                    <div class="empty-state">
                        <div class="icon">📂</div>
                        <div>Select a destination directory above</div>
                    </div>
                </div>
                <div class="selection-bar hidden" id="destSelection">
                    <span><span class="count" id="destSelCount">0</span> files selected</span>
                    <button class="btn" onclick="clearSelection('dest')" style="padding:3px 10px;font-size:11px;">Clear</button>
                </div>
            </div>
        </div>
    </div>

    <!-- Status Bar -->
    <div class="statusbar">
        <div class="statusbar-left">
            <div class="status-indicator">
                <span class="dot"></span>
                Ready
            </div>
            <span id="statusMsg"></span>
        </div>
        <div class="statusbar-right">
            <span id="statusRight">Port System v1.0</span>
        </div>
    </div>
</div>

<!-- File Preview Modal -->
<div class="modal-overlay" id="previewModal">
    <div class="modal">
        <div class="modal-header">
            <div>
                <div class="modal-title" id="previewTitle">file.php</div>
                <div class="modal-meta" id="previewMeta"></div>
            </div>
            <button class="modal-close" onclick="closePreview()">✕</button>
        </div>
        <div class="modal-body">
            <pre id="previewContent"></pre>
        </div>
    </div>
</div>

<!-- Port Confirmation Modal -->
<div class="modal-overlay" id="confirmModal">
    <div class="modal" style="max-width:620px;">
        <div class="modal-header">
            <div>
                <div class="modal-title">⇄ Confirm Port</div>
                <div class="modal-meta" id="confirmMeta"></div>
            </div>
            <button class="modal-close" onclick="closeConfirm()">✕</button>
        </div>
        <div class="modal-body" id="confirmBody" style="padding:16px 20px;max-height:50vh;"></div>
        <div class="modal-footer">
            <button class="btn" onclick="closeConfirm()">Cancel</button>
            <button class="btn btn-port" id="confirmRunBtn" onclick="executePort()">⇄ Execute Port</button>
        </div>
    </div>
</div>

<!-- Port Result Modal -->
<div class="modal-overlay" id="resultModal">
    <div class="modal" style="max-width:660px;">
        <div class="modal-header">
            <div>
                <div class="modal-title" id="resultTitle">Port Complete</div>
                <div class="modal-meta" id="resultMeta"></div>
            </div>
            <button class="modal-close" onclick="closeResult()">✕</button>
        </div>
        <div class="modal-body" id="resultBody" style="padding:16px 20px;max-height:60vh;"></div>
        <div class="modal-footer">
            <button class="btn" onclick="closeResult()">Close</button>
        </div>
    </div>
</div>

<!-- History / Backups Modal -->
<div class="modal-overlay" id="historyModal">
    <div class="modal" style="max-width:750px;max-height:85vh;">
        <div class="modal-header">
            <div>
                <div class="modal-title">📋 Port History</div>
                <div class="modal-meta">Backups stored in _port_backups/</div>
            </div>
            <button class="modal-close" onclick="closeHistory()">✕</button>
        </div>
        <div class="modal-body" id="historyBody" style="padding:12px 16px;"></div>
    </div>
</div>

<script>
// =====================================================
// State
// =====================================================
const state = {
    destName: '',
    sourceTree: null,
    destTree: null,
    comparison: null,
    selectedSource: new Set(),
    selectedDest: new Set(),
    openDirs: { source: new Set(), dest: new Set() },
    excludeDirs: new Set(),
    // Shift-click tracking: last clicked path in each tree panel
    lastClickedTree: { source: null, dest: null },
    // Shift-click tracking per diff section (keyed by section title)
    lastClickedDiff: {},
};

// =====================================================
// Helpers
// =====================================================
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

async function api(action, params = {}) {
    const qs = new URLSearchParams({ action, ...params });
    const resp = await fetch('?' + qs.toString());
    return resp.json();
}

function formatSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function setStatus(msg) {
    $('#statusMsg').textContent = msg;
}

async function loadSkipDirs() {
    const data = await api('get_source_dirs');
    if (!data.dirs) return;

    state.excludeDirs.clear();
    for (const d of data.dirs) {
        if (d.skipped) state.excludeDirs.add(d.name);
    }
}

async function toggleExcludeDir(dirName) {
    const nowSkipped = !state.excludeDirs.has(dirName);

    // Persist to config file
    const result = await api('toggle_skip', { dir: dirName, skip: nowSkipped ? '1' : '0' });
    if (result.error) {
        setStatus('Error saving config: ' + result.error);
        return;
    }

    if (nowSkipped) {
        state.excludeDirs.add(dirName);
    } else {
        state.excludeDirs.delete(dirName);
    }

    // Reload trees to reflect new exclude state
    reloadTrees();
}

async function reloadTrees() {
    setStatus('Reloading trees…');
    try {
        const srcData = await api('get_tree', { which: 'source', exclude: getExcludeString() });
        if (srcData.tree) {
            state.sourceTree = srcData.tree;
            refreshTree('source');
            $('#sourceStats').textContent = countFiles(srcData.tree) + ' files, ' + countDirs(srcData.tree) + ' dirs';
        }
    } catch (e) {}

    if (state.destName) {
        try {
            const destData = await api('get_tree', { which: 'dest', dest: state.destName, exclude: getExcludeString() });
            if (destData.tree) {
                state.destTree = destData.tree;
                refreshTree('dest');
                $('#destStats').textContent = countFiles(destData.tree) + ' files, ' + countDirs(destData.tree) + ' dirs';
            }
        } catch (e) {}
    }

    // Clear comparison since excludes changed
    $('#compPanel').classList.add('hidden');
    state.comparison = null;
    $('#portBtn').disabled = true;
    setStatus('Ready');
}

function getExcludeString() {
    return Array.from(state.excludeDirs).join(',');
}

function countFiles(tree) {
    let count = 0;
    for (const item of tree) {
        if (item.type === 'file') count++;
        else if (item.children) count += countFiles(item.children);
    }
    return count;
}

function countDirs(tree) {
    let count = 0;
    for (const item of tree) {
        if (item.type === 'dir') {
            count++;
            if (item.children) count += countDirs(item.children);
        }
    }
    return count;
}

// =====================================================
// Tree Rendering
// =====================================================

/**
 * Get ordered list of visible file paths in a tree panel (from the DOM).
 */
function getVisibleFilePaths(which) {
    const container = which === 'source' ? $('#sourceTree') : $('#destTree');
    const rows = container.querySelectorAll('.tree-item[data-type="file"]');
    return Array.from(rows).map(r => r.dataset.path);
}

function renderTree(tree, container, which, depth = 0) {
    for (const item of tree) {
        const row = document.createElement('div');
        row.className = 'tree-item';
        row.dataset.path = item.path;
        row.dataset.type = item.type;

        // Indentation
        for (let i = 0; i < depth; i++) {
            const indent = document.createElement('span');
            indent.className = 'tree-indent';
            row.appendChild(indent);
        }

        // Checkbox
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'tree-checkbox';
        cb.dataset.path = item.path;
        cb.dataset.which = which;
        cb.dataset.itemType = item.type;
        cb.addEventListener('change', (e) => {
            e.stopPropagation();
            onCheckboxChange(which, item, cb.checked);
        });
        row.appendChild(cb);

        if (item.type === 'dir') {
            // Toggle arrow
            const toggle = document.createElement('span');
            toggle.className = 'tree-toggle' + (item.children && item.children.length ? '' : ' empty');
            if (item.excluded) toggle.className = 'tree-toggle empty';
            toggle.innerHTML = '▶';
            if (state.openDirs[which].has(item.path)) toggle.classList.add('open');
            row.appendChild(toggle);

            // Folder icon
            const icon = document.createElement('span');
            icon.className = 'tree-icon dir';
            icon.textContent = item.excluded ? '🚫' : '📁';
            row.appendChild(icon);

            // Name
            const name = document.createElement('span');
            name.className = 'tree-name';
            name.textContent = item.name;
            row.appendChild(name);

            // Show excluded badge or child count
            if (item.excluded) {
                row.classList.add('skipped-row');
                const badge = document.createElement('span');
                badge.className = 'skipped-label';
                badge.textContent = 'skipped';
                row.appendChild(badge);
            } else if (item.children) {
                const meta = document.createElement('span');
                meta.className = 'tree-meta';
                const fc = countFiles(item.children);
                const dc = countDirs(item.children);
                let parts = [];
                if (dc > 0) parts.push(dc + ' dir' + (dc > 1 ? 's' : ''));
                if (fc > 0) parts.push(fc + ' file' + (fc > 1 ? 's' : ''));
                meta.textContent = parts.join(', ');
                row.appendChild(meta);
            }

            // Skip toggle button — only on top-level source directories
            if (which === 'source' && depth === 0) {
                const skipBtn = document.createElement('button');
                skipBtn.className = 'skip-toggle' + (item.excluded ? ' is-skipped' : '');
                skipBtn.title = item.excluded ? 'Include this folder in comparisons' : 'Skip this folder in comparisons';
                skipBtn.innerHTML = item.excluded ? '◉' : '⊘';
                skipBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleExcludeDir(item.name);
                });
                row.appendChild(skipBtn);
            }

            if (!item.excluded) {
                row.addEventListener('click', (e) => {
                    if (e.target.classList.contains('tree-checkbox')) return;
                    if (e.target.closest('.skip-toggle')) return;
                    toggleDir(which, item.path, container, tree, depth);
                });
            } else {
                // Clicking an excluded dir just toggles it back on
                row.addEventListener('click', (e) => {
                    if (e.target.classList.contains('tree-checkbox')) return;
                    if (e.target.closest('.skip-toggle')) return;
                    toggleExcludeDir(item.name);
                });
            }
        } else {
            // Spacer for alignment
            const spacer = document.createElement('span');
            spacer.className = 'tree-toggle empty';
            row.appendChild(spacer);

            // File icon
            const icon = document.createElement('span');
            icon.className = 'tree-icon file';
            icon.textContent = getFileIcon(item.name);
            row.appendChild(icon);

            // Name
            const name = document.createElement('span');
            name.className = 'tree-name';
            name.textContent = item.name;
            row.appendChild(name);

            // Size
            const meta = document.createElement('span');
            meta.className = 'tree-meta';
            meta.textContent = formatSize(item.size);
            row.appendChild(meta);

            // Single click toggles selection for files
            row.addEventListener('click', (e) => {
                if (e.target.classList.contains('tree-checkbox')) return;
                const selected = which === 'source' ? state.selectedSource : state.selectedDest;

                if (e.shiftKey && state.lastClickedTree[which]) {
                    // Shift-click: select range between last clicked and this
                    const visibleFiles = getVisibleFilePaths(which);
                    const lastIdx = visibleFiles.indexOf(state.lastClickedTree[which]);
                    const curIdx = visibleFiles.indexOf(item.path);
                    if (lastIdx !== -1 && curIdx !== -1) {
                        const start = Math.min(lastIdx, curIdx);
                        const end = Math.max(lastIdx, curIdx);
                        for (let i = start; i <= end; i++) {
                            selected.add(visibleFiles[i]);
                        }
                    } else {
                        selected.add(item.path);
                    }
                } else if (e.ctrlKey || e.metaKey) {
                    // Ctrl/Cmd click: toggle single item
                    if (selected.has(item.path)) {
                        selected.delete(item.path);
                    } else {
                        selected.add(item.path);
                    }
                } else {
                    // Plain click: toggle single item
                    if (selected.has(item.path)) {
                        selected.delete(item.path);
                    } else {
                        selected.add(item.path);
                    }
                }

                state.lastClickedTree[which] = item.path;
                refreshTree(which);
            });

            // Double click opens preview
            row.addEventListener('dblclick', (e) => {
                if (e.target.classList.contains('tree-checkbox')) return;
                previewFile(which, item.path);
            });
        }

        // Apply checked highlight
        const selectedSet = which === 'source' ? state.selectedSource : state.selectedDest;
        if (selectedSet.has(item.path)) {
            row.classList.add('checked');
        }

        container.appendChild(row);

        // Render children if open
        if (item.type === 'dir' && item.children && state.openDirs[which].has(item.path)) {
            renderTree(item.children, container, which, depth + 1);
        }
    }
}

function getFileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const map = {
        php: '🐘', js: '📜', ts: '📘', jsx: '⚛', tsx: '⚛',
        html: '🌐', htm: '🌐', css: '🎨', scss: '🎨',
        json: '📋', xml: '📋', yml: '📋', yaml: '📋',
        md: '📝', txt: '📄', log: '📄',
        png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', webp: '🖼',
        sql: '🗃', db: '🗃',
        sh: '⚙', bash: '⚙', env: '⚙', ini: '⚙', conf: '⚙',
        zip: '📦', tar: '📦', gz: '📦',
        py: '🐍', rb: '💎', go: '🔵', rs: '🦀', java: '☕',
    };
    return map[ext] || '📄';
}

function toggleDir(which, path, fullContainer, fullTree, depth) {
    if (state.openDirs[which].has(path)) {
        state.openDirs[which].delete(path);
    } else {
        state.openDirs[which].add(path);
    }
    refreshTree(which);
}

function refreshTree(which) {
    const tree = which === 'source' ? state.sourceTree : state.destTree;
    const container = which === 'source' ? $('#sourceTree') : $('#destTree');
    if (!tree) return;
    container.innerHTML = '';
    renderTree(tree, container, which);
    restoreCheckboxes(which);
    updateSelectionBar(which);
}

function restoreCheckboxes(which) {
    const selected = which === 'source' ? state.selectedSource : state.selectedDest;
    const container = which === 'source' ? $('#sourceTree') : $('#destTree');
    const checkboxes = container.querySelectorAll('.tree-checkbox');
    checkboxes.forEach(cb => {
        if (selected.has(cb.dataset.path)) cb.checked = true;
    });
}

function onCheckboxChange(which, item, checked) {
    const selected = which === 'source' ? state.selectedSource : state.selectedDest;

    if (checked) {
        selected.add(item.path);
        // If directory, also select all children
        if (item.type === 'dir' && item.children) {
            selectAllChildren(item.children, selected);
        }
    } else {
        selected.delete(item.path);
        if (item.type === 'dir' && item.children) {
            deselectAllChildren(item.children, selected);
        }
    }
    refreshTree(which);
}

function selectAllChildren(children, selected) {
    for (const item of children) {
        selected.add(item.path);
        if (item.type === 'dir' && item.children) {
            selectAllChildren(item.children, selected);
        }
    }
}

function deselectAllChildren(children, selected) {
    for (const item of children) {
        selected.delete(item.path);
        if (item.type === 'dir' && item.children) {
            deselectAllChildren(item.children, selected);
        }
    }
}

function clearSelection(which) {
    if (which === 'source') state.selectedSource.clear();
    else state.selectedDest.clear();
    refreshTree(which);
}

function updateSelectionBar(which) {
    const selected = which === 'source' ? state.selectedSource : state.selectedDest;
    const bar = which === 'source' ? $('#sourceSelection') : $('#destSelection');
    const countEl = which === 'source' ? $('#sourceSelCount') : $('#destSelCount');
    if (!bar || !countEl) return;
    // Count only files
    const tree = which === 'source' ? state.sourceTree : state.destTree;
    if (!tree) return;
    let fileCount = 0;
    selected.forEach(p => {
        if (!isDir(tree, p)) fileCount++;
    });

    if (fileCount > 0) {
        bar.classList.remove('hidden');
        countEl.textContent = fileCount;
    } else {
        bar.classList.add('hidden');
    }
}

function isDir(tree, path) {
    for (const item of tree) {
        if (item.path === path) return item.type === 'dir';
        if (item.type === 'dir' && item.children) {
            const result = isDir(item.children, path);
            if (result !== undefined) return result;
        }
    }
    return undefined;
}

// =====================================================
// Comparison Rendering
// =====================================================
function renderComparison(data) {
    const body = $('#compBody');
    body.innerHTML = '';

    // Summary grid
    const grid = document.createElement('div');
    grid.className = 'summary-grid';
    grid.innerHTML = `
        <div class="summary-card">
            <div class="num num-green">${data.only_in_source.length}</div>
            <div class="label">New files</div>
        </div>
        <div class="summary-card">
            <div class="num num-red">${data.only_in_dest.length}</div>
            <div class="label">Missing files</div>
        </div>
        <div class="summary-card">
            <div class="num num-yellow">${data.modified_files.length}</div>
            <div class="label">Modified</div>
        </div>
        <div class="summary-card">
            <div class="num num-purple">${data.mismatched_dirs.length}</div>
            <div class="label">Mismatched dirs</div>
        </div>
    `;
    body.appendChild(grid);

    // Show excluded dirs notice
    if (data.excluded && data.excluded.length > 0) {
        const notice = document.createElement('div');
        notice.style.cssText = 'font-family:var(--mono);font-size:11px;color:var(--text-muted);padding:6px 12px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:16px;display:flex;align-items:center;gap:8px;';
        notice.innerHTML = '<span style="color:var(--accent-orange);">⚡</span> Skipped: <strong style="color:var(--text-secondary);">' + data.excluded.join(', ') + '</strong>';
        body.appendChild(notice);
    }

    // New files (only in source)
    if (data.only_in_source.length > 0) {
        renderDiffSection(body, 'New in Source', data.only_in_source.length, 'badge-new', 'NEW',
            data.only_in_source.map(f => ({ path: f })), true, 'source');
    }

    // Only in dest
    if (data.only_in_dest.length > 0) {
        renderDiffSection(body, 'Only in Destination', data.only_in_dest.length, 'badge-missing', 'DEST',
            data.only_in_dest.map(f => ({ path: f })), true, 'dest');
    }

    // Modified files
    if (data.modified_files.length > 0) {
        renderDiffSection(body, 'Modified Files', data.modified_files.length, 'badge-modified', 'MOD',
            data.modified_files.map(f => ({
                path: f.path,
                detail: (f.method === 'content' ? '≠ content' : formatSize(f.source_size) + ' → ' + formatSize(f.dest_size)),
            })), true, 'source');
    }

    // Dirs only in source
    if (data.dirs_only_in_source.length > 0) {
        renderDiffSection(body, 'Folders Only in Source', data.dirs_only_in_source.length, 'badge-dir', 'DIR',
            data.dirs_only_in_source.map(f => ({ path: f })), false, 'source');
    }

    // Dirs only in dest
    if (data.dirs_only_in_dest.length > 0) {
        renderDiffSection(body, 'Folders Only in Destination', data.dirs_only_in_dest.length, 'badge-dir', 'DIR',
            data.dirs_only_in_dest.map(f => ({ path: f })), false, 'dest');
    }

    // Mismatched dirs
    if (data.mismatched_dirs.length > 0) {
        renderDiffSection(body, 'Mismatched Folders', data.mismatched_dirs.length, 'badge-mismatch', 'DIFF',
            data.mismatched_dirs.map(f => ({
                path: f.path,
                detail: f.reason.replace(/_/g, ' '),
            })), false, 'source');
    }

    // All matched
    if (data.matched_dirs.length > 0) {
        const section = document.createElement('div');
        section.className = 'diff-section';
        section.innerHTML = `
            <div class="diff-section-header" style="border-radius:var(--radius);">
                <span style="color:var(--accent-green);font-size:12px;">✓</span>
                <span class="diff-section-title" style="color:var(--accent-green);">Matched Folders</span>
                <span class="diff-section-count">${data.matched_dirs.length}</span>
            </div>
        `;
        body.appendChild(section);
    }

    // Enable port button if there's anything to port
    const hasWork = data.only_in_source.length > 0 || data.modified_files.length > 0 ||
                    data.dirs_only_in_source.length > 0 || data.mismatched_dirs.length > 0;
    $('#portBtn').disabled = !hasWork;
}

function renderDiffSection(parent, title, count, badgeClass, badgeText, items, open, targetPanel) {
    const section = document.createElement('div');
    section.className = 'diff-section';

    const header = document.createElement('div');
    header.className = 'diff-section-header';
    header.innerHTML = `
        <span class="toggle ${open ? 'open' : ''}">▶</span>
        <span class="diff-section-title">${title}</span>
        <span class="diff-section-count">${count}</span>
    `;

    // Select All button
    const selectAllBtn = document.createElement('button');
    selectAllBtn.className = 'diff-select-all';
    selectAllBtn.textContent = 'Select All';
    selectAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const selected = targetPanel === 'source' ? state.selectedSource : state.selectedDest;
        const allPaths = items.map(i => i.path);
        // Check if all are already selected — if so, deselect all
        const allSelected = allPaths.every(p => selected.has(p));
        if (allSelected) {
            allPaths.forEach(p => selected.delete(p));
            selectAllBtn.textContent = 'Select All';
        } else {
            allPaths.forEach(p => selected.add(p));
            selectAllBtn.textContent = 'Deselect All';
        }
        // Update highlighting on diff items in this section
        updateDiffItemHighlights(bodyEl, items, targetPanel);
        // Refresh the tree panel to reflect selection
        refreshTree(targetPanel);
    });
    header.appendChild(selectAllBtn);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'diff-section-body';
    if (!open) bodyEl.classList.add('hidden');

    for (const item of items) {
        const row = document.createElement('div');
        row.className = 'diff-item';
        row.dataset.path = item.path;
        row.dataset.target = targetPanel;

        // Check if already selected
        const selected = targetPanel === 'source' ? state.selectedSource : state.selectedDest;
        if (selected.has(item.path)) row.classList.add('diff-selected');

        row.innerHTML = `
            <span class="diff-badge ${badgeClass}">${badgeText}</span>
            <span class="diff-path" title="${item.path}">${item.path}</span>
            ${item.detail ? `<span class="diff-detail">${item.detail}</span>` : ''}
        `;

        row.addEventListener('click', (e) => {
            const sel = targetPanel === 'source' ? state.selectedSource : state.selectedDest;
            const sectionKey = title; // unique per section

            if (e.shiftKey && state.lastClickedDiff[sectionKey]) {
                // Shift-click: select range
                const allRows = Array.from(bodyEl.querySelectorAll('.diff-item'));
                const allPaths = allRows.map(r => r.dataset.path);
                const lastIdx = allPaths.indexOf(state.lastClickedDiff[sectionKey]);
                const curIdx = allPaths.indexOf(item.path);
                if (lastIdx !== -1 && curIdx !== -1) {
                    const start = Math.min(lastIdx, curIdx);
                    const end = Math.max(lastIdx, curIdx);
                    for (let i = start; i <= end; i++) {
                        sel.add(allPaths[i]);
                        allRows[i].classList.add('diff-selected');
                    }
                }
            } else if (e.ctrlKey || e.metaKey) {
                // Ctrl/Cmd click: toggle this one item
                if (sel.has(item.path)) {
                    sel.delete(item.path);
                    row.classList.remove('diff-selected');
                } else {
                    sel.add(item.path);
                    row.classList.add('diff-selected');
                }
            } else {
                // Plain click: clear other selections in THIS section, select only this
                const rows = bodyEl.querySelectorAll('.diff-item');
                rows.forEach(r => {
                    const rPath = r.dataset.path;
                    sel.delete(rPath);
                    r.classList.remove('diff-selected');
                });
                sel.add(item.path);
                row.classList.add('diff-selected');
            }

            state.lastClickedDiff[sectionKey] = item.path;

            // Update select-all button text
            const allPaths = items.map(i => i.path);
            const allSel = allPaths.every(p => sel.has(p));
            selectAllBtn.textContent = allSel ? 'Deselect All' : 'Select All';

            refreshTree(targetPanel);
        });

        bodyEl.appendChild(row);
    }

    header.addEventListener('click', (e) => {
        if (e.target.closest('.diff-select-all')) return;
        const toggle = header.querySelector('.toggle');
        toggle.classList.toggle('open');
        bodyEl.classList.toggle('hidden');
    });

    section.appendChild(header);
    section.appendChild(bodyEl);
    parent.appendChild(section);
}

function updateDiffItemHighlights(bodyEl, items, targetPanel) {
    const selected = targetPanel === 'source' ? state.selectedSource : state.selectedDest;
    const rows = bodyEl.querySelectorAll('.diff-item');
    rows.forEach(row => {
        if (selected.has(row.dataset.path)) {
            row.classList.add('diff-selected');
        } else {
            row.classList.remove('diff-selected');
        }
    });
}

// =====================================================
// File Preview
// =====================================================
async function previewFile(which, filePath) {
    const params = { which, file: filePath };
    if (which === 'dest') params.dest = state.destName;

    setStatus('Loading preview…');
    const data = await api('preview_file', params);
    setStatus('');

    if (data.error) {
        alert(data.error);
        return;
    }

    $('#previewTitle').textContent = data.name;
    $('#previewMeta').textContent = `${formatSize(data.size)} • Modified: ${data.modified}`;
    $('#previewContent').textContent = data.content || '[No preview available for this file type]';
    $('#previewModal').classList.add('visible');
}

function closePreview() {
    $('#previewModal').classList.remove('visible');
}

// Close modals on backdrop click
['previewModal', 'confirmModal', 'resultModal', 'historyModal'].forEach(id => {
    $('#' + id).addEventListener('click', (e) => {
        if (e.target.id === id) {
            $('#' + id).classList.remove('visible');
        }
    });
});

// Close modals on Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closePreview();
        closeConfirm();
        closeResult();
        closeHistory();
    }
});

// =====================================================
// Initialization
// =====================================================
async function init() {
    setStatus('Loading…');

    // Load persisted skip-directory config
    await loadSkipDirs();

    // Load siblings
    const sibData = await api('get_siblings');
    const select = $('#destSelect');
    for (const sib of sibData.siblings) {
        const opt = document.createElement('option');
        opt.value = sib.name;
        opt.textContent = sib.name;
        select.appendChild(opt);
    }

    // Load source tree
    const srcData = await api('get_tree', { which: 'source', exclude: getExcludeString() });
    state.sourceTree = srcData.tree;
    refreshTree('source');
    $('#sourceStats').textContent = countFiles(srcData.tree) + ' files, ' + countDirs(srcData.tree) + ' dirs';

    setStatus('Ready');

    // Dest selector change
    select.addEventListener('change', async () => {
        state.destName = select.value;
        $('#compareBtn').disabled = !select.value;
        $('#compPanel').classList.add('hidden');
        state.comparison = null;
        state.destTree = null;
        $('#portBtn').disabled = true;

        if (select.value) {
            $('#destName').textContent = select.value;
            setStatus('Loading destination tree…');
            try {
                const destData = await api('get_tree', { which: 'dest', dest: select.value, exclude: getExcludeString() });
                if (destData.error) {
                    $('#destTree').innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><div>${destData.error}</div></div>`;
                    setStatus('Error');
                    return;
                }
                state.destTree = destData.tree;
                refreshTree('dest');
                $('#destStats').textContent = countFiles(destData.tree) + ' files, ' + countDirs(destData.tree) + ' dirs';
                setStatus('Ready — click Compare');
            } catch (err) {
                $('#destTree').innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><div>Failed to load directory</div></div>`;
                setStatus('Error loading destination');
            }
        } else {
            $('#destName').textContent = 'None selected';
            $('#destTree').innerHTML = '<div class="empty-state"><div class="icon">📂</div><div>Select a destination directory above</div></div>';
            $('#destStats').textContent = '';
            state.destTree = null;
        }
    });

    // Compare button
    $('#compareBtn').addEventListener('click', async () => {
        if (!state.destName) return;
        setStatus('Comparing directories…');
        $('#compareBtn').disabled = true;
        $('#compareBtn').textContent = 'Comparing…';

        // Ensure destination tree is loaded
        if (!state.destTree) {
            $('#destName').textContent = state.destName;
            const destData = await api('get_tree', { which: 'dest', dest: state.destName, exclude: getExcludeString() });
            if (destData.error) {
                $('#destTree').innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><div>${destData.error}</div></div>`;
                setStatus('Error loading destination');
                $('#compareBtn').disabled = false;
                $('#compareBtn').textContent = 'Compare';
                return;
            }
            state.destTree = destData.tree;
            refreshTree('dest');
            $('#destStats').textContent = countFiles(destData.tree) + ' files, ' + countDirs(destData.tree) + ' dirs';
        }

        const data = await api('compare', {
            dest: state.destName,
            exclude: Array.from(state.excludeDirs).join(','),
        });

        if (data.error) {
            setStatus('Error: ' + data.error);
            $('#compareBtn').disabled = false;
            $('#compareBtn').textContent = 'Compare';
            return;
        }

        state.comparison = data;
        $('#compPanel').classList.remove('hidden');
        renderComparison(data);

        $('#compareBtn').disabled = false;
        $('#compareBtn').textContent = 'Compare';
        setStatus('Comparison complete — ' +
            (data.only_in_source.length + data.modified_files.length) + ' files to port');
    });

    // Port button — show confirmation modal
    $('#portBtn').addEventListener('click', () => {
        showPortConfirm();
    });

    // History button
    $('#historyBtn').addEventListener('click', () => {
        showHistory();
    });
}

// =====================================================
// Port Execution
// =====================================================

function getSelectedFiles() {
    const tree = state.sourceTree;
    if (!tree) return [];
    const files = [];
    state.selectedSource.forEach(p => {
        if (!isDir(tree, p)) files.push(p);
    });
    return files;
}

function showPortConfirm() {
    const files = getSelectedFiles();
    if (files.length === 0) {
        alert('No files selected. Select files in the source panel first.');
        return;
    }
    if (!state.destName) {
        alert('No destination selected.');
        return;
    }

    // Categorize files
    let overwriteCount = 0;
    let newCount = 0;
    const compData = state.comparison;

    const destFileSet = new Set();
    if (compData) {
        // Files that exist in dest
        compData.modified_files.forEach(f => destFileSet.add(f.path));
        compData.only_in_dest.forEach(f => destFileSet.add(f));
        // Files in both but identical aren't in any diff list, but exist in dest
    }

    // Build file list with type
    const fileDetails = files.map(f => {
        // Check if this file is in modified or only-in-source
        let type = 'new';
        if (compData) {
            if (compData.modified_files.some(m => m.path === f)) type = 'overwrite';
            else if (!compData.only_in_source.includes(f)) type = 'overwrite'; // exists in both but maybe identical
        }
        if (type === 'overwrite') overwriteCount++;
        else newCount++;
        return { path: f, type };
    });

    $('#confirmMeta').textContent = `${files.length} files → ${state.destName}`;

    const body = $('#confirmBody');
    body.innerHTML = '';

    // Summary
    const summary = document.createElement('div');
    summary.className = 'confirm-summary';
    summary.innerHTML = `
        <div class="confirm-stat">
            <div class="num" style="color:var(--accent-green);">${newCount}</div>
            <div class="label">New files</div>
        </div>
        <div class="confirm-stat">
            <div class="num" style="color:var(--accent-yellow);">${overwriteCount}</div>
            <div class="label">Overwrite</div>
        </div>
        <div class="confirm-stat">
            <div class="num" style="color:var(--text-primary);">${files.length}</div>
            <div class="label">Total</div>
        </div>
    `;
    body.appendChild(summary);

    // File list
    const listEl = document.createElement('div');
    listEl.className = 'confirm-file-list';
    fileDetails.forEach(f => {
        const item = document.createElement('div');
        item.className = 'confirm-file-item';
        const badge = f.type === 'overwrite' ? '<span class="diff-badge badge-modified">OVR</span>' : '<span class="diff-badge badge-new">NEW</span>';
        item.innerHTML = `${badge}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${f.path}">${f.path}</span>`;
        listEl.appendChild(item);
    });
    body.appendChild(listEl);

    // Warning
    if (overwriteCount > 0) {
        const warn = document.createElement('div');
        warn.className = 'confirm-warning';
        warn.innerHTML = `⚠️ ${overwriteCount} existing file${overwriteCount > 1 ? 's' : ''} will be backed up to <strong>_port_backups/</strong> before overwriting.`;
        body.appendChild(warn);
    }

    $('#confirmModal').classList.add('visible');
}

function closeConfirm() { $('#confirmModal').classList.remove('visible'); }
function closeResult() { $('#resultModal').classList.remove('visible'); }
function closeHistory() { $('#historyModal').classList.remove('visible'); }

async function executePort() {
    const files = getSelectedFiles();
    if (files.length === 0) return;

    $('#confirmRunBtn').disabled = true;
    $('#confirmRunBtn').textContent = 'Porting…';
    setStatus('Executing port…');

    try {
        const resp = await fetch('?action=execute_port', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dest: state.destName, files }),
        });
        const result = await resp.json();

        closeConfirm();
        $('#confirmRunBtn').disabled = false;
        $('#confirmRunBtn').textContent = '⇄ Execute Port';

        if (result.error) {
            alert('Port failed: ' + result.error);
            setStatus('Port failed');
            return;
        }

        showPortResult(result);

        // Reload dest tree to reflect changes
        const destData = await api('get_tree', { which: 'dest', dest: state.destName, exclude: getExcludeString() });
        if (destData.tree) {
            state.destTree = destData.tree;
            refreshTree('dest');
            $('#destStats').textContent = countFiles(destData.tree) + ' files, ' + countDirs(destData.tree) + ' dirs';
        }

        setStatus('Port complete — ' + result.summary.total_operations + ' operations');
    } catch (e) {
        closeConfirm();
        $('#confirmRunBtn').disabled = false;
        $('#confirmRunBtn').textContent = '⇄ Execute Port';
        alert('Port failed: ' + e.message);
        setStatus('Port failed');
    }
}

function showPortResult(result) {
    const s = result.summary;
    const hasErrors = s.error_count > 0;

    $('#resultTitle').textContent = hasErrors ? '⚠️ Port Completed with Errors' : '✓ Port Complete';
    $('#resultMeta').textContent = `${result.timestamp_human} — Backup: ${result.id}`;

    const body = $('#resultBody');
    body.innerHTML = '';

    // Summary grid
    const grid = document.createElement('div');
    grid.className = 'confirm-summary';
    grid.innerHTML = `
        <div class="confirm-stat">
            <div class="num" style="color:var(--accent-green);">${s.files_copied_new}</div>
            <div class="label">Copied new</div>
        </div>
        <div class="confirm-stat">
            <div class="num" style="color:var(--accent-yellow);">${s.files_overwritten}</div>
            <div class="label">Overwritten</div>
        </div>
        <div class="confirm-stat">
            <div class="num" style="color:${hasErrors ? 'var(--accent-red)' : 'var(--text-muted)'};">${s.error_count}</div>
            <div class="label">Errors</div>
        </div>
    `;
    body.appendChild(grid);

    // Operations log
    if (result.operations.length > 0) {
        const sec = document.createElement('div');
        sec.className = 'result-section';
        sec.innerHTML = '<div class="result-section-title">Operations</div>';
        const list = document.createElement('div');
        list.className = 'result-op-list';
        result.operations.forEach(op => {
            const item = document.createElement('div');
            item.className = 'result-op-item';
            const badge = op.type === 'overwrite'
                ? '<span class="diff-badge badge-modified">OVR</span>'
                : '<span class="diff-badge badge-new">NEW</span>';
            item.innerHTML = `${badge}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${op.file}">${op.file}</span>`;
            list.appendChild(item);
        });
        sec.appendChild(list);
        body.appendChild(sec);
    }

    // Errors
    if (result.errors.length > 0) {
        const sec = document.createElement('div');
        sec.className = 'result-section';
        sec.innerHTML = '<div class="result-section-title" style="color:var(--accent-red);">Errors</div>';
        const list = document.createElement('div');
        list.className = 'result-op-list';
        result.errors.forEach(err => {
            const item = document.createElement('div');
            item.className = 'result-op-item';
            item.innerHTML = `<span class="diff-badge badge-missing">ERR</span><span style="flex:1;color:var(--accent-red);">${err.file}: ${err.error}</span>`;
            list.appendChild(item);
        });
        sec.appendChild(list);
        body.appendChild(sec);
    }

    // Backup info
    const info = document.createElement('div');
    info.className = 'confirm-warning';
    info.style.cssText = 'background:rgba(91,156,246,0.1);border-color:rgba(91,156,246,0.3);color:var(--accent-blue);margin-top:12px;';
    info.innerHTML = `💾 Backup saved as <strong>${result.id}</strong> — use History to restore if needed.`;
    body.appendChild(info);

    $('#resultModal').classList.add('visible');
}

// =====================================================
// History & Restore
// =====================================================

async function showHistory() {
    const body = $('#historyBody');
    body.innerHTML = '<div class="empty-state"><div class="spinner"></div><div>Loading backups…</div></div>';
    $('#historyModal').classList.add('visible');

    const data = await api('list_backups');
    if (!data.backups || data.backups.length === 0) {
        body.innerHTML = '<div class="empty-state"><div class="icon">📋</div><div>No port backups found</div></div>';
        return;
    }

    body.innerHTML = '';
    for (const b of data.backups) {
        const s = b.summary || {};
        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
            <div class="history-info">
                <div class="history-title">${b.source_name} → ${b.dest_name}</div>
                <div class="history-detail">
                    ${b.timestamp_human} — ${s.files_copied_new || 0} new, ${s.files_overwritten || 0} overwritten${s.error_count ? ', ' + s.error_count + ' errors' : ''}
                </div>
            </div>
            <div class="history-actions">
                <button class="btn" style="padding:4px 10px;font-size:11px;" onclick="viewBackupDetail('${b.id}')">Details</button>
                <button class="btn" style="padding:4px 10px;font-size:11px;color:var(--accent-yellow);" onclick="confirmRestore('${b.id}')">Restore</button>
            </div>
        `;
        body.appendChild(item);
    }
}

async function viewBackupDetail(portId) {
    const data = await api('get_backup', { id: portId });
    if (data.error) {
        alert(data.error);
        return;
    }

    // Show in preview modal
    $('#previewTitle').textContent = 'Backup: ' + portId;
    $('#previewMeta').textContent = data.timestamp_human + ' — ' + data.source_name + ' → ' + data.dest_name;
    $('#previewContent').textContent = JSON.stringify(data, null, 2);
    $('#previewModal').classList.add('visible');
}

async function confirmRestore(portId) {
    if (!confirm(`Restore backup "${portId}"?\n\nThis will:\n• Restore overwritten files to their original state\n• Delete files that were newly copied\n• Remove directories that were created\n\nThis cannot be undone.`)) {
        return;
    }

    setStatus('Restoring…');
    try {
        const resp = await fetch('?action=execute_restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: portId }),
        });
        const result = await resp.json();

        if (result.error) {
            alert('Restore failed: ' + result.error);
            setStatus('Restore failed');
            return;
        }

        let msg = `Restore complete:\n• ${result.files_restored} files restored\n• ${result.files_deleted} new files removed\n• ${result.dirs_removed} directories removed`;
        if (result.errors && result.errors.length > 0) {
            msg += `\n• ${result.errors.length} errors occurred`;
        }
        alert(msg);
        setStatus('Restore complete');

        // Refresh history and dest tree
        showHistory();
        if (state.destName) {
            const destData = await api('get_tree', { which: 'dest', dest: state.destName, exclude: getExcludeString() });
            if (destData.tree) {
                state.destTree = destData.tree;
                refreshTree('dest');
                $('#destStats').textContent = countFiles(destData.tree) + ' files, ' + countDirs(destData.tree) + ' dirs';
            }
        }
    } catch (e) {
        alert('Restore failed: ' + e.message);
        setStatus('Restore failed');
    }
}

init();
</script>
</body>
</html>