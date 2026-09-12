/**
 * Expo filesystem adapter for the local media repository.
 *
 * This module (together with the recorder/player bindings) is the ONLY place
 * that imports Expo media/filesystem modules; the repository, controller and
 * coordinator stay pure and testable with injected ports.
 *
 * Uses the current `File` / `Directory` / `Paths` API — no deprecated method
 * workarounds and no web `fs` shims. Absolute paths are derived from the CURRENT
 * sandbox roots on every call (the container path can change between
 * installations/restores and is never persisted).
 */
import { Directory, File, Paths } from 'expo-file-system';
import { OBJECTS_RELATIVE, STAGING_RELATIVE, type FileStat, type MediaFilePort } from './localMediaRepository';

/** Strips trailing separators so containment checks compare like strings. */
function trimSlash(uri: string): string {
  return uri.replace(/\/+$/, '');
}

function isDirectoryPath(uri: string): boolean {
  try {
    return Paths.info(uri).isDirectory === true;
  } catch {
    return false;
  }
}

function existsPath(uri: string): boolean {
  try {
    return Paths.info(uri).exists;
  } catch {
    return false;
  }
}

export function createExpoMediaFilePort(): MediaFilePort {
  const stagingRoot = new Directory(Paths.cache, ...STAGING_RELATIVE.split('/'));
  const objectsRoot = new Directory(Paths.document, ...OBJECTS_RELATIVE.split('/'));

  return {
    roots: () => ({ staging: trimSlash(stagingRoot.uri), objects: trimSlash(objectsRoot.uri) }),

    join: (...parts) =>
      parts
        .map((part, index) => (index === 0 ? trimSlash(part) : part.replace(/^\/+|\/+$/g, '')))
        .filter((part) => part.length > 0)
        .join('/'),

    // Paths are already `file://` URIs derived from the current sandbox root.
    toUri: (absolutePath) => absolutePath,

    async ensureDir(absolutePath) {
      const directory = new Directory(absolutePath);
      if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
    },

    async stat(absolutePath): Promise<FileStat> {
      if (!existsPath(absolutePath)) return { exists: false, sizeBytes: null, isDirectory: false };
      if (isDirectoryPath(absolutePath)) return { exists: true, sizeBytes: null, isDirectory: true };
      const file = new File(absolutePath);
      const size = file.exists && Number.isFinite(file.size) ? file.size : null;
      return { exists: true, sizeBytes: size, isDirectory: false };
    },

    async copy(from, to) {
      await new File(from).copy(new File(to));
    },

    async move(from, to) {
      await new File(from).move(new File(to));
    },

    async remove(absolutePath) {
      if (!existsPath(absolutePath)) return; // idempotent: nothing to do
      if (isDirectoryPath(absolutePath)) {
        new Directory(absolutePath).delete();
        return;
      }
      new File(absolutePath).delete();
    },

    async listNames(absolutePath) {
      const directory = new Directory(absolutePath);
      if (!directory.exists) return [];
      return directory.list().map((entry) => trimSlash(entry.uri).split('/').pop() ?? '');
    },

    async readText(absolutePath) {
      const file = new File(absolutePath);
      if (!file.exists) return null;
      return await file.text();
    },

    async writeText(absolutePath, text) {
      const file = new File(absolutePath);
      if (!file.exists) file.create({ intermediates: true });
      file.write(text);
    },
  };
}
