const cp = require('child_process');
const path = require('path');

const electronPath = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

const child = cp.spawn(electronPath, ['.'], {
  stdio: 'inherit',
  cwd: __dirname,
  env,
});

child.on('exit', (code) => process.exit(code || 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
