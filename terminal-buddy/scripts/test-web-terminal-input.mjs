import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const transpile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const helpers = {};
runInNewContext(transpile('../web/src/utils/terminalInput.ts'), { exports: helpers });
const { terminalPaste } = helpers;

function fixture() {
  const slots = [], frames = [], sent = [], submitted = [];
  let cursor = 0, tree, writable = true, connected = true, draft = '已有内容 ';
  const input = {
    value: '', selectionStart: 0, selectionEnd: 0, scrollHeight: 44, style: {},
    focus() {},
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  };
  // Model a terminal editor: bracketed paste inserts text, while Enter submits it.
  const send = data => {
    if (!writable) return false;
    sent.push(data);
    if (data.startsWith('\x1b[200~')) {
      assert.ok(data.endsWith('\x1b[201~'));
      draft += data.slice(6, -6);
    } else if (data === '\r') {
      submitted.push(draft);
      draft = '';
    } else if (data === '\x03') {
      draft = '';
    } else if (/^\x7f+$/.test(data)) {
      draft = Array.from(draft).slice(0, -data.length).join('');
    } else {
      throw new Error('Unexpected input: ' + JSON.stringify(data));
    }
    return true;
  };
  const jsx = (type, props) => ({ type, props });
  const component = {};
  runInNewContext(transpile('../web/src/components/InputBar.tsx'), {
    exports: component,
    requestAnimationFrame: callback => frames.push(callback),
    document: { activeElement: input },
    require: name => {
      if (name === 'react') return {
        useState: initial => {
          const index = cursor++;
          if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
          return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
        },
        useRef: current => {
          const index = cursor++;
          if (!(index in slots)) slots[index] = { current };
          return slots[index];
        },
        useId: () => 'input-id',
      };
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'lucide-react') return {};
      if (name === '../utils/terminalInput') return helpers;
      throw new Error('Unexpected import: ' + name);
    },
  });
  const nodes = node => {
    if (!node || typeof node !== 'object') return [];
    return [node, ...[node.props?.children ?? []].flat(Infinity).flatMap(nodes)];
  };
  const find = predicate => {
    const node = nodes(tree).find(predicate);
    assert.ok(node, 'Expected rendered input or button');
    return node.props;
  };
  const textarea = () => find(node => node.type === 'textarea');
  const render = () => {
    cursor = 0;
    tree = component.default({ connected, onSend: send, onText: text => send(terminalPaste(text, true)) });
    const props = textarea();
    props.ref.current = input;
    input.value = props.value;
    for (const frame of frames.splice(0)) frame();
  };
  const change = (text, start = text.length, end = start) => {
    input.value = text;
    input.setSelectionRange(start, end);
    textarea().onChange({ target: input });
    render();
  };
  const click = label => {
    const props = find(node => node.type === 'button' && node.props['aria-label'] === label);
    assert.ok(!props.disabled, `Button ${label} must be enabled`);
    props.onClick();
    render();
  };
  render();
  return {
    sent, submitted, input, textarea, change, click,
    get draft() { return draft; },
    composeStart() { textarea().onCompositionStart(); },
    composeEnd(text) { input.value = text; textarea().onCompositionEnd({ currentTarget: input }); render(); },
    enter(nativeEvent = {}) {
      let prevented = false;
      textarea().onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent, preventDefault() { prevented = true; } });
      render();
      return prevented;
    },
    disconnect() { connected = false; writable = false; render(); },
    reconnect() { connected = true; writable = true; render(); },
    rejectSend() { writable = false; },
  };
}

{
  const f = fixture();
  f.change('h');
  f.change('hello');
  assert.equal(f.draft, '已有内容 hello', 'Typing reaches the terminal before Send');
  assert.deepEqual(f.submitted, []);
  f.change('heLlo');
  assert.equal(f.draft, '已有内容 heLlo', 'Editing in the middle updates the terminal suffix');
  f.change('ho');
  assert.equal(f.draft, '已有内容 ho', 'Selection deletion is reflected remotely');
  f.click('清空同步输入');
  assert.equal(f.draft, '已有内容 ', 'Clear removes only the text tracked by the input');
  f.change('你好🚀');
  f.click('发送 Backspace');
  assert.equal(f.draft, '已有内容 你好', 'One Backspace removes a supplementary Unicode character');
  f.click('发送回车，提交终端输入');
  assert.deepEqual(f.submitted, ['已有内容 你好']);
  assert.equal(f.sent.at(-1), '\r', 'Send is a separate Enter, with no duplicate text');
  assert.equal(f.textarea().value, '');
  f.change('下一条');
  assert.equal(f.draft, '下一条', 'Submitting resets the tracking baseline');
}
{
  const f = fixture();
  f.composeStart();
  f.change('zhong');
  f.change('中');
  assert.deepEqual(f.sent, [], 'IME candidates never leak into the terminal');
  assert.equal(f.enter({ isComposing: true }), false);
  f.composeEnd('中文');
  f.change('中文');
  assert.equal(f.draft, '已有内容 中文');
  assert.equal(f.sent.length, 1, 'Composition end and the trailing change send committed text once');
  assert.equal(f.enter({ keyCode: 229 }), false, 'Safari candidate confirmation does not submit');
  assert.deepEqual(f.submitted, []);
  assert.equal(f.enter(), true);
  assert.deepEqual(f.submitted, ['已有内容 中文']);
}
{
  const f = fixture();
  f.change('第一行\n第二行');
  assert.equal(f.draft, '已有内容 第一行\r第二行');
  assert.deepEqual(f.submitted, [], 'Pasted newlines are text rather than Enter keys');
  f.click('发送 Enter');
  assert.deepEqual(f.submitted, ['已有内容 第一行\r第二行']);
  assert.equal(f.sent.at(-1), '\r');
}
{
  const f = fixture();
  f.change('ab', 1);
  f.click('插入 /');
  assert.equal(f.textarea().value, 'a/b');
  assert.equal(f.draft, '已有内容 a/b', 'Symbol chips use the same live synchronization');
  f.change('a/\nb');
  assert.equal(f.draft, '已有内容 a/\rb', 'Typing a newline still uses bracketed paste');
  assert.deepEqual(f.submitted, []);
}
{
  const f = fixture();
  f.change('ab');
  const count = f.sent.length;
  f.click('发送 ←');
  assert.equal(f.sent.length, count, 'Cursor chips edit the input without invalidating its tracked text');
  assert.equal(f.textarea().value, 'ab');
  assert.equal(f.input.selectionStart, 1);
  f.click('插入 /');
  assert.equal(f.draft, '已有内容 a/b');
  f.click('发送 Home');
  f.click('发送 Backspace');
  assert.equal(f.draft, '已有内容 a/b', 'Backspace at the start never erases earlier terminal input');
  f.click('发送 End');
  f.click('发送 Backspace');
  assert.equal(f.draft, '已有内容 a/');
}
{
  const f = fixture();
  f.change('取消');
  f.click('发送 Ctrl+C');
  f.change('新的命令');
  assert.equal(f.draft, '新的命令', 'Interrupt resets tracking before the next input');
  f.disconnect();
  assert.equal(f.textarea().disabled, true);
  const before = f.sent.length;
  f.enter();
  assert.equal(f.sent.length, before, 'Disconnected input must not be falsely acknowledged');
  assert.equal(f.textarea().value, '新的命令');
  f.reconnect();
  f.rejectSend();
  f.click('发送回车，提交终端输入');
  assert.equal(f.textarea().value, '新的命令', 'A failed submission preserves its input');
  f.reconnect();
  f.click('发送回车，提交终端输入');
  assert.deepEqual(f.submitted, ['新的命令']);
  f.click('发送回车，提交终端输入');
  assert.deepEqual(f.submitted, ['新的命令', ''], 'Empty input can confirm a terminal prompt');
}

assert.equal(terminalPaste('plain', false), 'plain');
assert.equal(terminalPaste('中文\r\n粘贴\n文本', true), '\x1b[200~中文\r粘贴\r文本\x1b[201~');
assert.equal(terminalPaste('x\x1b[201~y', true), '\x1b[200~x␛[201~y\x1b[201~', 'Text cannot inject a premature paste terminator');

console.log('Mobile terminal input checks passed: live edits, Unicode deletion, clear, IME, separate Enter, multiline paste, symbols, interrupt and connection failures.');
