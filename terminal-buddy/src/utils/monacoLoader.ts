import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';

// 复用本地打包的 monaco-editor 实例，阻止 @monaco-editor/react 从 jsdelivr CDN
// 额外加载第二套（且不同版本的）Monaco 脚本与 worker。
loader.config({ monaco });

/**
 * 搭配 DiffEditor 的 keepCurrentOriginalModel/keepCurrentModifiedModel：
 * 延迟到 diffEditor 完成 dispose 后再销毁 ITextModel，避免 @monaco-editor/react
 * 默认先销毁 model 再销毁 widget 引起的异常及切文件时的模型泄漏。
 */
export function attachSafeDiffModelDisposal(
  diffEditor: monaco.editor.IStandaloneDiffEditor,
): monaco.IDisposable {
  const models = diffEditor.getModel();
  return diffEditor.onDidDispose(() => {
    queueMicrotask(() => {
      try { models?.original?.dispose(); } catch {}
      try { models?.modified?.dispose(); } catch {}
    });
  });
}

export { monaco };
