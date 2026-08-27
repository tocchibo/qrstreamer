const assert = require('node:assert/strict');
const fs = require('node:fs');

function verifyDomReferences(scriptPath, htmlPath) {
    const script = fs.readFileSync(scriptPath, 'utf8');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const ids = new Set(Array.from(html.matchAll(/\bid=["']([^"']+)["']/g), match => match[1]));
    const references = Array.from(script.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g), match => match[1]);

    for (const id of references) {
        assert.ok(ids.has(id), `${scriptPath} が参照する #${id} が ${htmlPath} にありません`);
    }
}

verifyDomReferences('js/sender.js', 'sender.html');
verifyDomReferences('js/receiver.js', 'receiver.html');
console.log('DOM contract tests: ok');
