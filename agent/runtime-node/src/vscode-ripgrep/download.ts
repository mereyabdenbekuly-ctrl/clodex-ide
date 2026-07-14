import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import util from 'node:util';
import url from 'node:url';
import type stream from 'node:stream';
import child_process from 'node:child_process';
import proxy_from_env from 'proxy-from-env';
import { HttpsProxyAgent } from 'https-proxy-agent';
import yauzl from 'yauzl'; // use yauzl ^2.9.2 because vscode already ships with it.

const fsUnlink = util.promisify(fs.unlink);
const fsExists = util.promisify(fs.exists);
const fsMkdir = util.promisify(fs.mkdir);

const isWindows = process.platform === 'win32';

const REPO = 'microsoft/ripgrep-prebuilt';

/**
 * @param {string} _url
 */
function isGithubUrl(_url: string) {
  return url.parse(_url).hostname === 'api.github.com';
}

/**
 * @param {string} _url
 * @param {fs.PathLike} dest
 * @param {any} opts
 */
function download(
  _url: string,
  dest: fs.PathLike,
  _opts: Record<string, any>,
  onLog?: (message: string) => void,
) {
  const proxy = proxy_from_env.getProxyForUrl(url.parse(_url));
  let opts: Record<string, any>;
  if (proxy !== '') {
    opts = {
      ..._opts,
      agent: new HttpsProxyAgent(proxy),
      proxy,
    };
  } else {
    opts = _opts;
  }

  if (opts.headers?.authorization && !isGithubUrl(_url)) {
    delete opts.headers.authorization;
  }

  return new Promise((resolve, reject) => {
    onLog?.(`Download options: ${JSON.stringify(opts)}`);
    const mergedOpts = {
      ...url.parse(_url),
      ...opts,
    };
    https
      .get(mergedOpts, (response) => {
        onLog?.(`statusCode: ${response.statusCode}`);
        if (
          [301, 302, 303, 307, 308].includes(response.statusCode ?? 0) &&
          response.headers.location
        ) {
          response.resume();
          onLog?.(`Following redirect to: ${response.headers.location}`);
          return download(response.headers.location!, dest, opts, onLog).then(
            resolve,
            reject,
          );
        } else if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Download failed with ${response.statusCode}`));
          return;
        }

        const outFile = fs.createWriteStream(dest);
        response.pipe(outFile);
        outFile.on('finish', () => {
          outFile.close(() => resolve(undefined));
        });
        outFile.on('error', async (error) => {
          response.destroy();
          try {
            await fsUnlink(dest);
          } catch {
            // The failed stream may not have created a file.
          }
          reject(error);
        });
      })
      .on('error', async (err) => {
        try {
          await fsUnlink(dest);
        } catch {
          // The request may fail before the destination file is created.
        }
        reject(err);
      });
  });
}

/**
 * @param {string} _url
 * @param {any} opts
 */
export function getRipgrepReleaseAssetUrl(
  version: string,
  assetName: string,
): string {
  return `https://github.com/${REPO}/releases/download/${encodeURIComponent(version)}/${encodeURIComponent(assetName)}`;
}

export function getRipgrepDownloadCacheDir(destinationDir: string): string {
  return path.join(
    path.dirname(path.dirname(destinationDir)),
    '.cache',
    'ripgrep',
  );
}

async function getAssetFromGithubRelease(
  opts: DownloadRipgrepOptions,
  assetName: string,
  downloadFolder: string,
  onLog?: (message: string) => void,
) {
  const assetDownloadPath = path.join(downloadFolder, assetName);

  // We can just use the cached binary
  if (!opts.force && (await fsExists(assetDownloadPath))) {
    onLog?.(`Using cached download: ${assetDownloadPath}`);
    return assetDownloadPath;
  }

  const downloadOpts: Record<string, any> = {
    headers: {
      'user-agent': 'vscode-ripgrep',
    },
  };

  const assetUrl = getRipgrepReleaseAssetUrl(opts.version, assetName);
  onLog?.(`Downloading from ${assetUrl}`);
  onLog?.(`Downloading to ${assetDownloadPath}`);
  await download(assetUrl, assetDownloadPath, downloadOpts, onLog);
}

/**
 * @param {string} zipPath
 * @param {string} destinationDir
 */
function unzipWindows(
  zipPath: string,
  destinationDir: string,
  onLog?: (message: string) => void,
) {
  onLog?.(`Unzipping Windows zip to ${destinationDir}`);
  // code from https://stackoverflow.com/questions/63932027/how-to-unzip-to-a-folder-using-yauzl
  return new Promise((resolve, reject) => {
    try {
      // Create folder if not exists
      fs.promises.mkdir(path.dirname(destinationDir), { recursive: true });

      // Same as example we open the zip.
      yauzl.open(
        zipPath,
        { lazyEntries: true },
        (err: Error | null, zipFile: yauzl.ZipFile) => {
          if (err) {
            zipFile?.close();
            reject(err);
            return;
          }

          // This is the key. We start by reading the first entry.
          zipFile.readEntry();

          // Now for every entry, we will write a file or dir
          // to disk. Then call zipFile.readEntry() again to
          // trigger the next cycle.
          zipFile.on('entry', (entry: yauzl.Entry) => {
            try {
              // Directories
              if (/\/$/.test(entry.fileName)) {
                // Create the directory then read the next entry.
                fs.promises.mkdir(path.join(destinationDir, entry.fileName), {
                  recursive: true,
                });
                zipFile.readEntry();
              }
              // Files
              else {
                // Write the file to disk.
                zipFile.openReadStream(
                  entry,
                  (readErr: Error | null, readStream: stream.Readable) => {
                    if (readErr) {
                      zipFile.close();
                      reject(readErr);
                      return;
                    }

                    const file = fs.createWriteStream(
                      path.join(destinationDir, entry.fileName),
                    );
                    readStream.pipe(file);
                    file.on('finish', () => {
                      // Wait until the file is finished writing, then read the next entry.
                      file.close(() => {
                        zipFile.readEntry();
                      });

                      file.on('error', (err) => {
                        zipFile.close();
                        reject(err);
                      });
                    });
                  },
                );
              }
            } catch (e) {
              zipFile.close();
              reject(e);
            }
          });
          zipFile.on('end', (_err: Error | null) => {
            resolve(undefined);
          });
          zipFile.on('error', (err: Error | null) => {
            zipFile.close();
            reject(err as Error);
          });
        },
      );
    } catch (e) {
      reject(e);
    }
  });
}

function untar(
  zipPath: string,
  destinationDir: string,
  onLog?: (message: string) => void,
) {
  return new Promise((resolve, reject) => {
    const unzipProc = child_process.spawn(
      'tar',
      ['xvf', zipPath, '-C', destinationDir],
      { stdio: 'inherit' },
    );
    unzipProc.on('error', (err) => {
      reject(err);
    });
    unzipProc.on('close', (code) => {
      onLog?.(`tar xvf exited with ${code}`);
      if (code !== 0) {
        reject(new Error(`tar xvf exited with ${code}`));
        return;
      }

      resolve(undefined);
    });
  });
}

async function unzipRipgrep(
  zipPath: string,
  destinationDir: string,
  onLog?: (message: string) => void,
) {
  if (isWindows) await unzipWindows(zipPath, destinationDir, onLog);
  else await untar(zipPath, destinationDir, onLog);

  const expectedName = path.join(destinationDir, 'rg');
  if (await fsExists(expectedName)) return expectedName;

  if (await fsExists(`${expectedName}.exe`)) return `${expectedName}.exe`;

  throw new Error(
    `Expecting rg or rg.exe unzipped into ${destinationDir}, didn't find one.`,
  );
}

export type DownloadRipgrepOptions = {
  version: string;
  target: string;
  destDir: string;
  force?: boolean;
  token?: string;
  onLog?: (message: string) => void;
};

export async function downloadRipgrep(opts: DownloadRipgrepOptions) {
  const extension = isWindows ? '.zip' : '.tar.gz';
  const assetName =
    ['ripgrep', opts.version, opts.target].join('-') + extension;

  const downloadCacheDir = getRipgrepDownloadCacheDir(opts.destDir);
  if (!(await fsExists(downloadCacheDir))) {
    await fsMkdir(downloadCacheDir, { recursive: true });
  }

  const assetDownloadPath = path.join(downloadCacheDir, assetName);
  try {
    await getAssetFromGithubRelease(
      opts,
      assetName,
      downloadCacheDir,
      opts.onLog,
    );
  } catch (e) {
    opts.onLog?.('Deleting invalid download cache');
    try {
      await fsUnlink(assetDownloadPath);
    } catch (_e) {
      opts.onLog?.('Failed to delete invalid download cache');
    }

    throw e as Error;
  }

  opts.onLog?.(`Unzipping to ${opts.destDir}`);
  try {
    const destinationPath = await unzipRipgrep(
      assetDownloadPath,
      opts.destDir,
      opts.onLog,
    );
    if (!isWindows) {
      await util.promisify(fs.chmod)(destinationPath, '755');
    }
  } catch (e) {
    opts.onLog?.('Deleting invalid download');

    try {
      await fsUnlink(assetDownloadPath);
    } catch (_e) {
      opts.onLog?.('Failed to delete invalid download');
    }

    throw e as Error;
  }
}
