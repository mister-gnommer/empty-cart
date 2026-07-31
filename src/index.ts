// Single entrypoint for `node dist/index.js` (per `package.json` scripts.start
// and contracts/lifecycle.md). Calls `runApp()`; any rejection that escapes
// (none should) results in a non-zero exit — the upstream fatal-handler is
// already responsible for logging the failure and exiting 1; this catch is the
// defensive backstop.
import { runApp } from './lifecycle/run-app';

runApp().catch(() => {
  // Fatal already logged upstream; ensure non-zero exit from the entrypoint
  // itself (the throw path inside runApp calls process.exit before rejection
  // propagates, but in case our throws are missed we still exit 1).
  process.exit(1);
});
