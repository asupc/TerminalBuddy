import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const exports = {};
runInNewContext(ts.transpileModule(
  readFileSync(new URL('../web/src/utils/terminalKeyboard.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } },
).outputText, { exports });
const { installTouchKeyboardGuard, installInputKeyboardGuard } = exports;

class Element {
  listeners = [];
  constructor(parent = null, className = '') {
    this.parent = parent;
    this.className = className;
    this.ownerDocument = parent?.ownerDocument ?? this;
  }
  contains(target) {
    for (let node = target; node; node = node.parent) if (node === this) return true;
    return false;
  }
  closest(selector) {
    for (let node = this; node; node = node.parent) if ('.' + node.className === selector) return node;
    return null;
  }
  addEventListener(type, callback, options) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners.push({ type, callback, capture });
  }
  removeEventListener(type, callback, options) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners = this.listeners.filter(item => item.type !== type || item.callback !== callback || item.capture !== capture);
  }
  fire(type, details = {}) {
    const event = { type, target: this, ...details };
    const path = [];
    for (let node = this; node; node = node.parent) path.push(node);
    for (const capture of [true, false]) {
      for (const node of capture ? [...path].reverse() : path) {
        for (const item of node.listeners.filter(item => item.type === type && item.capture === capture)) item.callback(event);
      }
    }
  }
}

function fixture({ maxTouchPoints = 1, readOnly = false, inputMode = '', disabled = false } = {}) {
  const doc = new Element();
  const viewport = Object.assign(new Element(), { height: 800, scale: 1 });
  const view = Object.assign(new Element(), { innerHeight: 800, innerWidth: 400, navigator: { maxTouchPoints }, visualViewport: viewport });
  doc.defaultView = view;
  let keyboardVisible = false, keyboardOpens = 0;
  const resize = height => { viewport.height = height; viewport.fire('resize'); };
  const makeInput = parent => Object.assign(new Element(parent), {
    readOnly: false, inputMode: 'text', disabled: false,
    focus() {
      if (this.disabled) return;
      doc.activeElement = this;
      if (!this.readOnly && this.inputMode !== 'none') {
        keyboardVisible = true;
        keyboardOpens++;
        resize(500);
      }
    },
    blur() { if (doc.activeElement === this) doc.activeElement = null; },
  });
  const element = new Element(doc, 'xterm');
  const textarea = Object.assign(makeInput(element), { readOnly, inputMode, disabled });
  const controls = new Element(doc, 'input-bar');
  const composer = makeInput(controls);
  const button = new Element(controls);
  const page = new Element(doc);
  // Simulate xterm listeners installed before application guards, including document gestures.
  element.addEventListener('mousedown', () => textarea.focus());
  doc.addEventListener('touchstart', event => { if (element.contains(event.target)) textarea.focus(); });
  const removeTerminalGuard = installTouchKeyboardGuard({ element, textarea });
  const removeInputGuard = installInputKeyboardGuard(composer);
  const touch = (target, type, x = 0, y = 0) => target.fire(type, { touches: { length: 1, item: () => ({ clientX: x, clientY: y }) } });
  return {
    doc, view, viewport, element, textarea, composer, button, page, resize, touch,
    get keyboardVisible() { return keyboardVisible; },
    get keyboardOpens() { return keyboardOpens; },
    hideKeyboard(notify = true) { keyboardVisible = false; if (notify) resize(800); },
    swipe(target = element, pointerType = 'touch') {
      target.fire('pointerdown', { pointerType });
      touch(target, 'touchstart');
      touch(target, 'touchmove', 0, 40);
      target.fire('touchend');
      target.fire('mousedown');
    },
    dispose() { removeInputGuard(); removeTerminalGuard(); },
  };
}

{
  const f = fixture();
  assert.equal(f.textarea.disabled, true, 'Touch devices cannot focus the hidden terminal input, even before the first gesture');
  f.composer.focus();
  assert.equal(f.doc.activeElement, f.composer);
  f.hideKeyboard();
  assert.equal(f.doc.activeElement, null, 'Android keyboard dismissal releases the retained composer focus');
  const opens = f.keyboardOpens;
  f.swipe();
  f.element.fire('mousedown');
  f.swipe();
  assert.equal(f.keyboardOpens, opens, 'Repeated swipes and delayed mouse events cannot reopen the keyboard');
  assert.equal(f.keyboardVisible, false);
  assert.equal(f.doc.activeElement, null, 'xterm cannot acquire focus through a disabled hidden input');
  f.composer.focus();
  assert.equal(f.keyboardVisible, true, 'Explicit composer input remains available');
  assert.equal(f.composer.disabled, false);
  f.dispose();
}
{
  const f = fixture();
  f.composer.focus();
  f.hideKeyboard(false); // WebViews may omit the viewport event and leave the composer focused.
  assert.equal(f.doc.activeElement, f.composer);
  f.touch(f.page, 'touchstart');
  assert.equal(f.doc.activeElement, null, 'Touching the page outside the terminal also clears stale input focus');
  f.swipe(f.page);
  assert.equal(f.keyboardVisible, false);
  f.composer.focus();
  f.hideKeyboard(false);
  f.touch(f.element, 'touchstart');
  assert.equal(f.doc.activeElement, null, 'Capture listeners run before xterm document gesture handlers without Pointer Events');
  f.dispose();
}
{
  const f = fixture();
  f.composer.focus();
  f.touch(f.button, 'touchstart');
  f.touch(f.button, 'touchmove', 1, 1);
  assert.equal(f.doc.activeElement, f.composer, 'Tapping toolbar controls preserves active typing');
  f.touch(f.button, 'touchmove', 40, 0);
  assert.equal(f.doc.activeElement, null, 'Swiping a shortcut row releases the input instead of refocusing it');
  f.composer.focus();
  f.touch(f.composer, 'touchstart');
  f.touch(f.composer, 'touchmove', 0, 40);
  assert.equal(f.doc.activeElement, f.composer, 'Scrolling or selecting within the editable input remains usable');
  f.dispose();
}
{
  const f = fixture();
  f.composer.focus();
  f.resize(540);
  assert.equal(f.doc.activeElement, f.composer, 'Keyboard suggestion bar changes do not blur typing');
  f.view.innerWidth = 800;
  f.resize(350);
  assert.equal(f.doc.activeElement, f.composer, 'Rotation is not treated as keyboard dismissal');
  f.viewport.scale = 2;
  f.resize(300);
  assert.equal(f.doc.activeElement, f.composer, 'Pinch zoom is not treated as keyboard dismissal');
  f.dispose();
}
{
  const f = fixture({ maxTouchPoints: 0 });
  assert.equal(f.textarea.disabled, false, 'Desktop terminals remain editable initially');
  f.swipe(f.element, 'pen');
  assert.equal(f.textarea.disabled, true);
  f.element.fire('pointerdown', { pointerType: 'mouse', sourceCapabilities: { firesTouchEvents: true } });
  assert.equal(f.textarea.disabled, true, 'Mouse events synthesized from touch cannot restore hidden input');
  f.element.fire('pointerdown', { pointerType: 'mouse' });
  assert.equal(f.textarea.disabled, false, 'A real mouse restores desktop terminal input on hybrid devices');
  assert.equal(f.textarea.readOnly, false);
  assert.equal(f.textarea.inputMode, '');
  f.dispose();
  assert.equal(f.doc.listeners.length, 1, 'Disposal preserves the original xterm listener');
  assert.equal(f.view.listeners.length, 0);
  assert.equal(f.viewport.listeners.length, 0);
  f.composer.focus();
  f.hideKeyboard();
  assert.equal(f.doc.activeElement, f.composer, 'Disposed viewport guards no longer alter focus');
}
{
  const f = fixture({ readOnly: true, inputMode: 'numeric', disabled: true });
  f.swipe();
  f.element.fire('pointerdown', { pointerType: 'mouse' });
  f.dispose();
  assert.equal(f.textarea.readOnly, true);
  assert.equal(f.textarea.inputMode, 'numeric');
  assert.equal(f.textarea.disabled, true, 'Mouse restoration and cleanup preserve existing disabled state');
}
installTouchKeyboardGuard({ element: undefined, textarea: undefined })();

console.log('Mobile keyboard checks passed: Android dismissal, retained focus, page/terminal/toolbar swipes, explicit input, hybrid mouse, viewport changes and cleanup.');
