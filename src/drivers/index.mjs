import { agyDriver } from './agy.mjs';
import { claudeDriver } from './claude.mjs';
import { codexDriver } from './codex.mjs';
import { dshDriver } from './dsh.mjs';

export const DRIVERS = {
  agy: agyDriver,
  codex: codexDriver,
  claude: claudeDriver,
  dsh: dshDriver,
};

export const PHASE2_TARGETS = new Set();

export function getDriver(targetId) {
  if (!targetId) {
    throw new Error('missing target harness: pass `--to <agy|codex|claude|dsh>`');
  }
  const id = String(targetId).toLowerCase();
  if (DRIVERS[id]) return DRIVERS[id];
  throw new Error(
    `unknown target "${targetId}" (active targets: ${Object.keys(DRIVERS).join(', ')})`
  );
}

export function listActiveTargetIds() {
  return Object.keys(DRIVERS);
}
