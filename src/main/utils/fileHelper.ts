/**
 * File Helper Utilities
 * Helper functions for file operations
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Get a unique file name if the file already exists
 * Appends (1), (2), etc. before the file extension
 * @param filePath - Full path to the file
 * @returns Unique file path that doesn't exist
 */
export function getUniqueFilePath(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return filePath;
  }

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);

  let counter = 1;
  let uniquePath = filePath;

  while (fs.existsSync(uniquePath)) {
    const newName = `${baseName} (${counter})${ext}`;
    uniquePath = path.join(dir, newName);
    counter++;
  }

  return uniquePath;
}

/**
 * Get unique file name (just the name, not full path)
 * @param fileName - Original file name
 * @param directory - Directory to check for existing files
 * @returns Unique file name
 */
export function getUniqueFileName(fileName: string, directory: string): string {
  const fullPath = path.join(directory, fileName);
  const uniquePath = getUniqueFilePath(fullPath);
  return path.basename(uniquePath);
}
