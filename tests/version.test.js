// Fails if logic.js and index.html disagree on the logic version (a stale cached logic.js would blank History/Summary).
const fs = require('fs'); const assert = require('assert');
const L = require('../logic.js'); const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const src = /logic\.js\?v=([^"']+)/.exec(html); const req = /REQUIRED_LOGIC_VERSION\s*=\s*'([^']+)'/.exec(html);
assert.ok(src && req, 'index.html must load logic.js?v=... and declare REQUIRED_LOGIC_VERSION');
assert.strictEqual(src[1], L.LOGIC_VERSION, 'script ?v= must equal LOGIC_VERSION');
assert.strictEqual(req[1], L.LOGIC_VERSION, 'REQUIRED_LOGIC_VERSION must equal LOGIC_VERSION');
const sw = fs.readFileSync(__dirname + '/../sw.js', 'utf8');
const swv = /const VERSION = '([^']+)'/.exec(sw);
assert.ok(swv && swv[1] === L.LOGIC_VERSION, 'sw.js VERSION must equal LOGIC_VERSION');
JSON.parse(fs.readFileSync(__dirname + '/../manifest.webmanifest', 'utf8'));
console.log('ok - logic version consistent (' + L.LOGIC_VERSION + ')');
