const fs = require('fs');
const vm = require('vm');

console.log('--- JAVASCRIPT SYNTAX INTEGRITY ---');
try {
  new vm.Script(fs.readFileSync('src/main.js', 'utf8'));
  console.log('• src/main.js:       ✅ 100% Valid');
} catch(e) {
  console.error('• src/main.js:       ❌ Syntax error:', e.message);
}

try {
  const c = fs.readFileSync('src/control.html', 'utf8');
  const scripts = [...c.matchAll(/<script[\s\S]*?>([\s\S]*?)<\/script>/gi)];
  scripts.forEach(s => new vm.Script(s[1]));
  console.log('• src/control.html:  ✅ 100% Valid');
} catch(e) {
  console.error('• src/control.html:  ❌ Syntax error:', e.message);
}

try {
  const o = fs.readFileSync('src/overlay.html', 'utf8');
  const scripts = [...o.matchAll(/<script[\s\S]*?>([\s\S]*?>)?([\s\S]*?)<\/script>/gi)];
  scripts.forEach(s => new vm.Script(s[2] || s[1]));
  console.log('• src/overlay.html:  ✅ 100% Valid');
} catch(e) {
  console.error('• src/overlay.html:  ❌ Syntax error:', e.message);
}
