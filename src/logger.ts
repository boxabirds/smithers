const LOG_LEVELS: Record<string, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface Logger {
  error(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  debug(message: string, extra?: Record<string, unknown>): void;
}

export function createLogger(service: string, level: string = 'info'): Logger {
  const minLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;

  function log(logLevel: string, message: string, extra?: Record<string, unknown>): void {
    if ((LOG_LEVELS[logLevel] ?? 0) > minLevel) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level: logLevel,
      service,
      message,
      ...extra,
    };

    const output = JSON.stringify(entry);

    if (logLevel === 'error') {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  }

  return {
    error: (message, extra) => log('error', message, extra),
    warn: (message, extra) => log('warn', message, extra),
    info: (message, extra) => log('info', message, extra),
    debug: (message, extra) => log('debug', message, extra),
  };
}
