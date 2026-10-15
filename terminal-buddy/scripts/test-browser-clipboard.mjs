import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const exports = {};
runInNewContext(ts.transpileModule(
  readFileSync(new URL('../src/components/terminal/browser-clipboard.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } },
).outputText, { exports });
const { installBrowserClipboard, isBrowserPasteShortcut } = exports;

// Node EventTarget requires the object form of capture when removing a listener.
class DomEvents extends EventTarget {
  addEventListener(type, callback, options) {
    super.addEventListener(type, callback, typeof options === 'boolean' ? { capture: options } : options);
  }
  removeEventListener(type, callback, options) {
    super.removeEventListener(type, callback, typeof options === 'boolean' ? { capture: options } : options);
  }
}
class Element extends DomEvents {
  ownerDocument = new DomEvents();
  attributes = new Map();
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
}
const event = (type, data = {}) => Object.assign(new Event(type, { cancelable: true }), data);
const pasteEvent = (text = '', files = []) => event('paste', {
  clipboardData: { files, getData: format => format === 'text/plain' ? text : '' },
});
function fixture(overrides = {}) {
  const calls = { texts: [], files: [], uploads: [], errors: [], focus: 0 };
  const element = new Element();
  const terminal = { element, paste: text => calls.texts.push(text), focus: () => calls.focus++ };
  let writable = true;
  const dispose = installBrowserClipboard(terminal, {
    canPaste: () => writable,
    uploadFiles: async files => { calls.uploads.push(files); return ['/uploads/image.png']; },
    insertFiles: paths => calls.files.push(...paths),
    onError: error => calls.errors.push(error),
    ...overrides,
  });
  return { element, calls, dispose, readOnly: () => { writable = false; } };
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

// No navigator.clipboard exists here: HTTP paste must use only the event payload.
{
  const f = fixture();
  let legacyPasteCalls = 0;
  f.element.addEventListener('paste', () => legacyPasteCalls++);
  const e = pasteEvent('第一行\r\n第二行');
  f.element.dispatchEvent(e);
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(f.calls.texts, ['第一行\r\n第二行']);
  assert.equal(legacyPasteCalls, 0, 'xterm default handler must not send a second paste');
  assert.equal(f.calls.focus, 1);
  f.dispose();
}
{
  const f = fixture();
  assert.equal(f.element.hasAttribute('data-native-context-menu'), true);
  const e = event('contextmenu');
  f.element.dispatchEvent(e);
  assert.equal(e.defaultPrevented, false, 'native context menu must remain available');
  assert.equal(f.element.hasAttribute('data-native-context-menu-open'), true);
  f.element.ownerDocument.dispatchEvent(event('keydown'));
  assert.equal(f.element.hasAttribute('data-native-context-menu-open'), false);
  f.element.dispatchEvent(event('mousedown', { button: 2 }));
  assert.equal(f.element.hasAttribute('data-native-context-menu-open'), true);
  f.element.dispatchEvent(pasteEvent('right click'));
  assert.equal(f.element.hasAttribute('data-native-context-menu-open'), false);
  f.dispose();
  assert.equal(f.element.hasAttribute('data-native-context-menu'), false);
}
{
  const f = fixture();
  f.readOnly();
  f.element.dispatchEvent(pasteEvent('blocked', [{ name: 'image.png' }]));
  await settle();
  assert.equal(f.calls.texts.length + f.calls.uploads.length, 0);
  f.dispose();
}
{
  const f = fixture();
  f.element.dispatchEvent(pasteEvent('image alt text', [{ name: 'image.png' }]));
  await settle();
  assert.equal(f.calls.uploads.length, 1);
  assert.deepEqual(f.calls.files, ['/uploads/image.png']);
  assert.deepEqual(f.calls.texts, []);
  f.dispose();
}
for (const action of ['readOnly', 'dispose']) {
  let resolveUpload;
  const f = fixture({ uploadFiles: () => new Promise(resolve => { resolveUpload = resolve; }) });
  f.element.dispatchEvent(pasteEvent('', [{ name: 'image.png' }]));
  f[action]();
  resolveUpload(['/uploads/late.png']);
  await settle();
  assert.equal(f.calls.files.length, 0, `${action} during upload must block insertion`);
  f.dispose();
}
{
  const failure = new Error('upload failed');
  const f = fixture({ uploadFiles: async () => { throw failure; } });
  f.element.dispatchEvent(pasteEvent('', [{ name: 'image.png' }]));
  await settle();
  assert.deepEqual(f.calls.errors, [failure]);
  f.dispose();
  const e = pasteEvent('after dispose');
  f.element.dispatchEvent(e);
  assert.equal(e.defaultPrevented, false);
  assert.deepEqual(f.calls.texts, []);
}
for (const shortcut of [
  { key: 'v', ctrlKey: true }, { key: 'V', ctrlKey: true, shiftKey: true },
  { key: 'v', metaKey: true }, { key: 'Insert', shiftKey: true },
]) assert.equal(isBrowserPasteShortcut({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...shortcut }), true);
for (const shortcut of [
  { key: 'v' }, { key: 'v', ctrlKey: true, altKey: true },
  { key: 'c', ctrlKey: true }, { key: 'Insert' },
]) assert.equal(isBrowserPasteShortcut({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...shortcut }), false);

console.log('Browser clipboard regression checks passed: native menu, single paste, shortcuts, readonly, image upload, async permissions, disposal and errors.');
