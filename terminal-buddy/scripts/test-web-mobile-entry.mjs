import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const desktopHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const mobileHtml = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

function runEntry(html, { mode = 'browser', path = '/', touch = false, iPad = false, search = '?token=quick-access&from=qr', hash = '#session' } = {}) {
  const redirects = [];
  const context = {
    window: {
      location: { pathname: path, search, hash, replace: url => redirects.push(url) },
      matchMedia: () => ({ matches: touch }),
      innerHeight: 844,
      addEventListener() {},
    },
    navigator: { userAgent: iPad ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)' : 'Desktop', maxTouchPoints: iPad ? 5 : 0 },
    document: { documentElement: { style: { setProperty() {} } } },
  };
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    runInNewContext(match[1].replaceAll('%MODE%', mode), context);
  }
  return redirects;
}

// A phone requesting a desktop user agent and an iPad must use the same mobile UI.
for (const device of [{ touch: true }, { iPad: true }]) {
  assert.deepEqual(runEntry(desktopHtml, device), ['/m/?token=quick-access&from=qr#session']);
  // Direct access needs no QR code or token; the mobile SPA presents password login.
  assert.deepEqual(runEntry(desktopHtml, { ...device, search: '', hash: '' }), ['/m/']);
}
// Native desktop, demo and mouse users must stay on their current entry.
assert.deepEqual(runEntry(desktopHtml), []);
assert.deepEqual(runEntry(desktopHtml, { search: '', hash: '' }), []);
assert.deepEqual(runEntry(desktopHtml, { mode: 'production', touch: true }), []);
assert.deepEqual(runEntry(desktopHtml, { mode: 'browser-demo', touch: true }), []);
assert.deepEqual(runEntry(desktopHtml, { path: '/m/', touch: true }), []);
assert.deepEqual(runEntry(mobileHtml, { path: '/m' }), ['/m/?token=quick-access&from=qr#session']);
assert.deepEqual(runEntry(mobileHtml, { path: '/m/' }), []);
assert.deepEqual(runEntry(mobileHtml), []);

const core = ts.transpileModule(
  readFileSync(new URL('../src/services/browser/core.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } },
).outputText;

function browserInvoke(href, token) {
  const exports = {};
  runInNewContext(core, {
    exports,
    URL,
    window: { location: { href } },
    require: name => {
      assert.equal(name, './connection');
      return {
        getToken: () => token,
        request: () => { throw new Error('Mobile links must not call unsupported desktop commands'); },
      };
    },
  });
  return exports.invoke;
}

for (const origin of ['http://192.168.3.202:9610', 'https://terminal.example.com']) {
  const token = 'signed+token/with=special&characters';
  const invoke = browserInvoke(origin + '/?old=value#desktop', token);
  assert.equal(await invoke('get_web_server_address'), origin + '/m/');
  const quick = new URL(await invoke('get_web_quick_access_url'));
  assert.equal(quick.origin, origin);
  assert.equal(quick.pathname, '/m/');
  assert.equal(quick.searchParams.get('token'), token);
  assert.equal(quick.hash, '');
  assert.equal(quick.searchParams.has('old'), false);
}
await assert.rejects(browserInvoke('http://example.com/', '')('get_web_quick_access_url'), /请先登录/);

console.log('Mobile entry checks passed: touch and iPad routing, native isolation, canonical paths, public ports, HTTPS and quick-access tokens.');
