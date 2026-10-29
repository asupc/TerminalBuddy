/* 必须先于终端依赖加载：旧版 WebView 的初始化错误也需要通知原生层。 */
(function () {
  'use strict';
  function reportError() {
    if (window.AndroidTerminal && typeof window.AndroidTerminal.error === 'function') {
      window.AndroidTerminal.error();
    }
  }
  window.addEventListener('error', reportError);
  window.addEventListener('unhandledrejection', reportError);
  // xterm 用于克隆默认终端模式；这些模式仅包含普通对象和布尔值。
  if (typeof window.structuredClone !== 'function') {
    window.structuredClone = function (value) { return JSON.parse(JSON.stringify(value)); };
  }
})();
