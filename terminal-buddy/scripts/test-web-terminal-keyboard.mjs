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
const { installTouchKeyboardGuard } = exports;

class Element {
  listeners = [];
  addEventListener(type, callback, options) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners.push({ type, callback, capture });
  }
  removeEventListener(type, callback, options) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners = this.listeners.filter(item => item.type !== type || item.callback !== callback || item.capture !== capture);
  }
  fire(type, details = {}) {
    const event = { type, ...details };
    for (const capture of [true, false]) {
      for (const item of this.listeners.filter(item => item.type === type && item.capture === capture)) {
        item.callback(event);
      }
    }
  }
}

function fixture({ readOnly = false, inputMode = '' } = {}) {
  const element = new Element();
  let keyboardVisible = false, keyboardOpens = 0;
  const createInput = () => ({
    readOnly: false, inputMode: 'text',
    focus() {
      if (!this.readOnly && this.inputMode !== 'none') {
        keyboardVisible = true;
        keyboardOpens++;
      }
    },
  });
  const textarea = Object.assign(createInput(), { readOnly, inputMode });
  const composer = createInput();
  // xterm registers focus handlers before our guard is installed.
  element.addEventListener('mousedown', () => textarea.focus());
  element.addEventListener('touchstart', () => textarea.focus());
  const dispose = installTouchKeyboardGuard({ element, textarea });
  return {
    element, textarea, composer, dispose,
    get keyboardVisible() { return keyboardVisible; },
    get keyboardOpens() { return keyboardOpens; },
    hideKeyboard() { keyboardVisible = false; },
    swipe(pointerType = 'touch') {
      element.fire('pointerdown', { pointerType });
      element.fire('touchstart');
      element.fire('touchmove');
      element.fire('touchend');
      // Some WebViews emit a compatibility mouse event after scrolling.
      element.fire('mousedown');
    },
  };
}

{
  const f = fixture();
  f.composer.focus();
  f.hideKeyboard(); // Android can leave the input focused after dismissing its keyboard.
  const opens = f.keyboardOpens;
  f.swipe();
  assert.equal(f.keyboardVisible, false, 'Scrolling after dismissing the keyboard must not reopen it');
  assert.equal(f.keyboardOpens, opens, 'Touch and compatibility mouse events cannot focus an editable hidden input');
  f.element.fire('mousedown');
  assert.equal(f.keyboardVisible, false, 'Delayed mouse events stay suppressed after touchend');
  f.swipe();
  assert.equal(f.keyboardVisible, false, 'Repeated scrolling keeps the keyboard dismissed');
  f.composer.focus();
  assert.equal(f.keyboardVisible, true, 'Explicitly tapping the composer still opens the keyboard');
  assert.equal(f.composer.readOnly, false);
  assert.equal(f.composer.inputMode, 'text');
  f.dispose();
}
{
  const f = fixture();
  f.element.fire('touchstart');
  f.element.fire('mousedown');
  assert.equal(f.keyboardVisible, false, 'Safari without Pointer Events uses the capture-phase touchstart guard');
  f.element.fire('pointerdown', { pointerType: 'mouse' });
  f.element.fire('mousedown');
  assert.equal(f.textarea.readOnly, false, 'A real mouse restores terminal input on hybrid devices');
  assert.equal(f.textarea.inputMode, '');
  f.hideKeyboard();
  f.swipe('pen');
  assert.equal(f.keyboardVisible, false, 'Stylus gestures also keep the keyboard closed');
  f.dispose();
  assert.equal(f.textarea.readOnly, false);
  assert.equal(f.textarea.inputMode, '');
  assert.equal(f.element.listeners.length, 2, 'Disposal removes only the guard listeners');
  f.element.fire('touchstart');
  assert.equal(f.keyboardVisible, true, 'Disposed guards no longer change terminal focus behavior');
}
{
  const f = fixture({ readOnly: true, inputMode: 'numeric' });
  f.swipe();
  f.element.fire('pointerdown', { pointerType: 'mouse' });
  assert.equal(f.textarea.readOnly, true, 'Mouse restoration preserves an existing readonly terminal');
  assert.equal(f.textarea.inputMode, 'numeric');
  f.dispose();
  assert.equal(f.textarea.readOnly, true);
  assert.equal(f.textarea.inputMode, 'numeric');
}
installTouchKeyboardGuard({ element: undefined, textarea: undefined })();

console.log('Mobile terminal keyboard checks passed: dismissed keyboard, repeated swipes, delayed mouse events, Safari fallback, explicit input, mouse/stylus and cleanup.');
