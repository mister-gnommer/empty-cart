export type LoggedLine = { level: string; msg: string; [k: string]: unknown };

type ChildlessLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
};

export type CapturedLogger = ChildlessLogger & {
  child: (bindings: Record<string, unknown>) => CapturedLogger;
};

export function makeCapturingLogger(): {
  logger: CapturedLogger;
  child: (bindings: Record<string, unknown>) => CapturedLogger;
  lines: LoggedLine[];
} {
  const lines: LoggedLine[] = [];
  function make(bindings: Record<string, unknown> = {}): CapturedLogger {
    function emit(severity: string, args: unknown[]): void {
      let merged: Record<string, unknown> = { ...bindings };
      for (const a of args) {
        if (a && typeof a === 'object') {
          merged = { ...merged, ...a };
        }
      }
      lines.push({ ...merged, level: severity, msg: String(merged.msg ?? '') });
    }
    return {
      info: (...a: unknown[]) => emit('info', a),
      warn: (...a: unknown[]) => emit('warn', a),
      error: (...a: unknown[]) => emit('error', a),
      fatal: (...a: unknown[]) => emit('fatal', a),
      debug: (...a: unknown[]) => emit('debug', a),
      trace: (...a: unknown[]) => emit('trace', a),
      child: (b: Record<string, unknown>) => make({ ...bindings, ...b }),
    };
  }
  const logger = make();
  return { logger, child: (b) => make(b), lines };
}
