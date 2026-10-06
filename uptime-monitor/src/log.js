// One JSON object per line, so log platforms can index fields. Never log cookies, tokens or passwords.
function write(level, msg, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}
export const log = {
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};
