import * as fs from 'fs';
import { addProject, ZipStats } from './zipLogic';

// `archiver`'s published type defs don't declare its callable default export correctly,
// so it's required directly rather than imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiver = require('archiver');

export class ZipCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export interface ZipOptions {
  /** Aborting it stops the zip at any point, including while it is compressing. */
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/**
 * Writes a zip of `targetDir` to `outputZipPath`, leaving out whatever git would ignore.
 *
 * Settles exactly once. It resolves when the file is complete and closed, and
 * rejects - with ZipCancelled when `signal` is aborted - on any failure, having
 * first closed the file and deleted it, so a failed or cancelled run never leaves
 * a partial zip behind. A destination that could not be opened is never deleted:
 * it may be an existing file this run did not write.
 */
export function createZip(targetDir: string, outputZipPath: string, options: ZipOptions = {}): Promise<ZipStats> {
  const { signal, onProgress } = options;

  return new Promise<ZipStats>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ZipCancelled());
      return;
    }

    const output = fs.createWriteStream(outputZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    let opened = false;
    let settled = false;
    let stats: ZipStats | undefined;

    const fail = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      archive.abort();
      const finish = () => {
        const removed = opened ? fs.promises.unlink(outputZipPath).catch(() => undefined) : Promise.resolve();
        removed.then(() => reject(err));
      };
      if (output.closed) {
        finish();
      } else {
        output.once('close', finish);
        output.destroy();
      }
    };
    const onAbort = () => fail(new ZipCancelled());
    signal?.addEventListener('abort', onAbort);

    output.on('open', () => {
      opened = true;
    });
    output.on('error', fail);
    output.on('close', () => {
      if (settled || !stats) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(stats);
    });
    archive.on('warning', (err: any) => {
      if (err.code !== 'ENOENT') {
        console.warn('archiver warning:', err);
      }
    });
    archive.on('error', fail);

    archive.pipe(output);

    addProject(archive, targetDir, outputZipPath, () => settled)
      .then((result) => {
        if (settled) {
          return;
        }
        stats = result;
        onProgress?.(`Compressing ${result.fileCount} files…`);
        return archive.finalize();
      })
      .catch(fail);
  });
}
