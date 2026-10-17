const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const dir = __dirname;
process.chdir(dir);

console.log('\n==========================================');
console.log(' InterviewAI Pro - Node.js Setup Script');
console.log('==========================================\n');

console.log('Node:', process.version);
console.log('Platform:', process.platform, os.arch());
console.log('Dir:', dir);
console.log('');

// Check if electron already installed
const electronExe = path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe');
if (fs.existsSync(electronExe)) {
  console.log('[OK] Electron already installed at:', electronExe);
  console.log('Launching...\n');
  const child = spawn(electronExe, ['src/main.js'], { stdio: 'inherit', detached: false });
  child.on('exit', code => { console.log('App exited with code:', code); });
  return;
}

console.log('[!] Electron not found. Running npm install...');
try {
  const out = execSync('npm install', { stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
  console.log(out);
} catch(e) {
  console.log('npm install output:', e.stdout);
  console.log('npm install error:', e.stderr);
}

if (fs.existsSync(electronExe)) {
  console.log('[OK] Electron installed! Launching...\n');
  const child = spawn(electronExe, ['src/main.js'], { stdio: 'inherit' });
  child.on('exit', code => console.log('Exited:', code));
} else {
  console.log('[FAIL] Electron binary not found even after install.');
  console.log('');
  console.log('Manual fix - run these in Command Prompt:');
  console.log('  cd "' + dir + '"');
  console.log('  npm install');
  console.log('  npx electron@28 src/main.js');
  console.log('');
}
