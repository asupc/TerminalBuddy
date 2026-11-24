import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import { loader } from '@monaco-editor/react';

// 复用本地打包的 monaco-editor 实例，阻止 @monaco-editor/react 从 jsdelivr CDN
// 额外加载第二套（且不同版本的）Monaco 脚本与 worker。
loader.config({ monaco });

// Monaco 的 ESM 包不会自行定位 worker。缺少 MonacoEnvironment 时它会把 worker 入口
// 内联成 data: URL，而内联脚本里的相对 import 无法解析，worker 启动失败；差异编辑器
// 拿不到 computeDiff 结果，表现就是「没有变更行高亮」。这里交给 Vite 的 ?worker
// 生成真正的 worker 文件（diff 计算依赖 editor worker，JSON 校验依赖 json worker）。
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new JsonWorker();
    return new EditorWorker();
  },
};

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
