import { isBrowserClient } from '../platform';
import { getBrowserWindow } from './browserWindow';
import { getNativeWindow } from './nativeWindow';

/** 窗口对象：浏览器构建走网页全屏模拟，桌面（含远程工作区）使用真实原生窗口。 */
export function getCurrentWindow() {
  return isBrowserClient() ? getBrowserWindow() : getNativeWindow();
}
