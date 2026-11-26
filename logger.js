'use strict';
// Structured JSON logging to stdout/stderr. On Vercel these lines appear in
// Runtime Logs and can be forwarded to any provider with a Log Drain.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function write(level, msg, fields) {
  if (LEVELS[level] < minLevel) return;
  const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  debug: (msg, f = {}) => write('debug', msg, f),
  info: (msg, f = {}) => write('info', msg, f),
  warn: (msg, f = {}) => write('warn', msg, f),
  error: (msg, f = {}) => write('error', msg, f),
};
