type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

const COLOUR: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

function emit(level: Level, msg: string, extra?: unknown) {
  if (ORDER[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${COLOUR[level]}${ts} ${level.toUpperCase().padEnd(5)}\x1b[0m ${msg}`;
  if (extra === undefined) console.log(line);
  else console.log(line, extra);
}

export const log = {
  debug: (m: string, e?: unknown) => emit('debug', m, e),
  info: (m: string, e?: unknown) => emit('info', m, e),
  warn: (m: string, e?: unknown) => emit('warn', m, e),
  error: (m: string, e?: unknown) => emit('error', m, e),
};
