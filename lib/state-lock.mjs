import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);

const TRANSIENT = ['EPERM', 'EBUSY', 'EACCES'];
const CONTENDED = ['EEXIST', 'ENOTEMPTY', ...TRANSIENT];
const READDIR_SAFE = ['ENOENT', 'ENOTDIR', ...TRANSIENT];
const REAP_SAFE = ['ENOENT', ...CONTENDED];

/** Atomic replace that survives Windows sharing violations. */
export function replaceFile(tmp, file) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      if (!TRANSIENT.includes(error.code) || attempt >= 50) throw error;
      pause();
    }
  }
}

/** Read a file that a concurrent writer may be replacing right now. */
export function readTextRetry(file) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (!TRANSIENT.includes(error.code) || attempt >= 50) throw error;
      pause();
    }
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function inspectAndReapStaleLock(lock) {
  let entries = [];
  let readErr = null;
  try {
    entries = fs.readdirSync(lock);
  } catch (error) {
    if (!READDIR_SAFE.includes(error.code)) throw error;
    if (error.code !== 'ENOENT') readErr = error;
  }
  if (entries.length === 1) {
    const match = /^owner-(\d+)-[a-f0-9-]+$/.exec(entries[0]);
    const holderPid = match ? Number(match[1]) : 0;
    if (holderPid > 1 && !alive(holderPid)) {
      try {
        fs.unlinkSync(path.join(lock, entries[0]));
        fs.rmdirSync(lock);
      } catch (error) {
        if (!REAP_SAFE.includes(error.code)) throw error;
      }
    }
  }
  return readErr;
}

function releaseAcquiredLock(lock, owner) {
  const marker = path.join(lock, owner);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.unlinkSync(marker);
      break;
    } catch (error) {
      if (error.code === 'ENOENT') break;
      if (TRANSIENT.includes(error.code) && attempt < 4) {
        pause();
        continue;
      }
      if (TRANSIENT.includes(error.code) && !fs.existsSync(marker)) break;
      throw error;
    }
  }
  try {
    fs.rmdirSync(lock);
  } catch (error) {
    if (!REAP_SAFE.includes(error.code)) throw error;
  }
}

/** Publish a nonempty lock directory atomically and reap dead holders safely. */
export function withStateLock(lock, change) {
  const owner = `owner-${process.pid}-${randomUUID()}`;
  const candidate = `${lock}.${owner}`;
  fs.mkdirSync(candidate);
  fs.writeFileSync(path.join(candidate, owner), '');
  const start = Date.now();
  let acquired = false;
  let lastError;
  let primaryError = null;
  try {
    for (;;) {
      try {
        fs.renameSync(candidate, lock);
        acquired = true;
        break;
      } catch (error) {
        if (!CONTENDED.includes(error.code)) throw error;
        lastError = error;
      }
      const reapErr = inspectAndReapStaleLock(lock);
      if (reapErr) lastError = reapErr;
      if (Date.now() - start > 10000) {
        const detail = lastError?.code ? ` (last error: ${lastError.code})` : '';
        throw new Error(
          `Timed out acquiring cospan state lock${detail}: ${lock}. If no cospan process is running, inspect and remove the stale lock.`
        );
      }
      pause();
    }
    return change();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (acquired) {
      try {
        releaseAcquiredLock(lock, owner);
      } catch (cleanupErr) {
        if (!primaryError) {
          process.stderr.write(`cospan warning: failed releasing state lock ${lock}: ${cleanupErr.message}\n`);
        }
      }
    } else {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
}
