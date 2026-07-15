/**
 * Mirrors electron-winstaller's NuGet/Squirrel version conversion. Build
 * metadata is removed and dots in the prerelease component are collapsed.
 */
export function toSquirrelInternalVersion(version) {
  const parts = version.split('+', 1)[0].split('-');
  const mainVersion = parts.shift();
  if (!mainVersion) {
    throw new Error('Squirrel version is empty');
  }
  if (parts.length === 0) return mainVersion;
  return `${mainVersion}-${parts.join('-').replaceAll('.', '')}`;
}
