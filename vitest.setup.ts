// Vitest setup — silence the "Promise rejection handled asynchronously"
// Node warning emitted by the lifecycle.spec.ts regime (deliberate
// `process.exit`-spy throws through detached async shutdown chains). The
// underlying rejections ARE handled (`await shutdownPromise` in runApp);
// Node prints this warning when the handling crosses a microtask boundary,
// so we attach a no-op `rejectionHandled` listener for hygiene (the warning
// is emitted by Node's internal Promise machinery and is not affected by
// `process.emitWarning` overrides; tests still pass with exit code 0 and
// Vitest surfaces any real unhandled rejections independently).
process.on('rejectionHandled', () => undefined);