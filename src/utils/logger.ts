/**
 * Log estruturado em JSON (uma linha por evento, stdout) — o EasyPanel coleta.
 * Chaves sensíveis são mascaradas: token, authorization, secret, key, password.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE = /token|authorization|secret|password|api[-_]?key|internal[-_]?key|cookie/i;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE.test(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return out;
}

export function createLogger(level: Level = 'info', sink: (line: string) => void = (line) => process.stdout.write(line + '\n')): Logger {
  const min = ORDER[level];
  const write = (lvl: Level, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < min) {
      return;
    }
    const entry = { ts: new Date().toISOString(), level: lvl, msg, ...(fields ? (redact(fields) as Record<string, unknown>) : {}) };
    try {
      sink(JSON.stringify(entry));
    } catch {
      sink(JSON.stringify({ ts: entry.ts, level: lvl, msg }));
    }
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}

export const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
