import { die, durationToMs, JOB_EXIT_CODES, parseCliArgs, printHelp } from './cli-args.mjs';
import { cmdConfig, cmdDoctor, cmdInstall } from './commands/admin.mjs';
import { cmdAsk, cmdContinue, cmdRestart, cmdSend } from './commands/dispatch.mjs';
import { cmdCancel, cmdObserve, cmdResult, cmdStatus, cmdWait } from './commands/lifecycle.mjs';
import { repoRoot, workspaceStateDir } from './job-store.mjs';
import { cmdWorker } from './job-worker.mjs';
import { checkForUpdate, PACKAGE_VERSION } from './update-check.mjs';

export { durationToMs, JOB_EXIT_CODES, parseCliArgs, repoRoot, workspaceStateDir };

const SUBCOMMAND_HANDLERS = {
  send: cmdSend,
  ask: cmdAsk,
  continue: cmdContinue,
  wait: cmdWait,
  observe: cmdObserve,
  result: cmdResult,
  cancel: cmdCancel,
  restart: cmdRestart,
  status: cmdStatus,
  config: cmdConfig,
  doctor: cmdDoctor,
  install: cmdInstall,
  _update_check: () => checkForUpdate(),
  _worker: (opts) => cmdWorker(opts._[0]),
};

export async function main(argv = process.argv.slice(2)) {
  try {
    const { subcmd, opts } = parseCliArgs(argv);
    if (opts.version) {
      process.stdout.write(`cospan ${PACKAGE_VERSION}\n`);
      return;
    }
    if (!subcmd || subcmd === 'help' || opts.help) {
      printHelp();
      return;
    }
    const handler = Object.prototype.hasOwnProperty.call(SUBCOMMAND_HANDLERS, subcmd)
      ? SUBCOMMAND_HANDLERS[subcmd]
      : null;
    if (!handler) {
      die(`unknown subcommand "${subcmd}" (run \`cospan --help\`)`);
    }
    await handler(opts);
  } catch (error) {
    if (!error?.alreadyPrinted) {
      process.stderr.write(`cospan error: ${error?.message || error}\n`);
    }
    process.exitCode = error?.exitCode ?? 1;
  }
}
