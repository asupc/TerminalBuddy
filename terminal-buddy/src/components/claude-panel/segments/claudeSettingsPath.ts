// settings 编辑器：子键路径读写 helper（content 为 serde_json::Value 对应的 plain object）。

/** 按 `a.b.c` 路径取值，缺失返回 undefined。 */
export function getPathValue(content: Record<string, unknown>, path: string): unknown {
  let current: unknown = content;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** 按路径设值（自动创建中间对象）。返回新对象（不改原对象）。 */
export function setPathValue(content: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const next: Record<string, unknown> = Array.isArray(content) ? [...content] as unknown as Record<string, unknown> : { ...content };
  const parts = path.split('.');
  let current = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const child = current[part];
    const childObj = (typeof child === 'object' && child !== null && !Array.isArray(child))
      ? { ...(child as Record<string, unknown>) }
      : {};
    current[part] = childObj;
    current = childObj;
  }
  current[parts[parts.length - 1]] = value;
  return next;
}

/** 按路径删值（空父对象一并清理）。返回新对象。 */
export function deletePathValue(content: Record<string, unknown>, path: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...content };
  const parts = path.split('.');
  const stack: Array<Record<string, unknown>> = [next];
  for (let i = 0; i < parts.length - 1; i++) {
    const child = stack[i][parts[i]];
    if (typeof child !== 'object' || child === null || Array.isArray(child)) return next;
    const childCopy = { ...(child as Record<string, unknown>) };
    stack[i][parts[i]] = childCopy;
    stack.push(childCopy);
  }
  delete stack[stack.length - 1][parts[parts.length - 1]];
  // 自底向上清理空对象
  for (let i = stack.length - 1; i > 0; i--) {
    if (Object.keys(stack[i]).length === 0) delete stack[i - 1][parts[i - 1]];
    else break;
  }
  return next;
}

/** 收集对象全部叶子路径（`a.b` 形态，数组视为叶子）。 */
export function collectLeafPaths(value: unknown, prefix: string, out: Set<string>): void {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      if (prefix) out.add(prefix);
      return;
    }
    for (const [key, child] of entries) {
      collectLeafPaths(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  if (prefix) out.add(prefix);
}

/** 路径的父节点是否可安全设值（父缺失或为普通对象；类型变化后删除标记会被值替换吞并）。 */
function parentSettable(content: Record<string, unknown>, path: string): boolean {
  const idx = path.lastIndexOf('.');
  if (idx < 0) return true;
  const parent: unknown = getPathValue(content, path.slice(0, idx));
  return parent === undefined
    || (typeof parent === 'object' && parent !== null && !Array.isArray(parent));
}

/**
 * 构建写回模型：`content` + 已删键的 `null` 标记（后端深合并的删除语义，
 * 未出现的键保留磁盘值）。表单 / JSON 两视图的保存统一走这里。
 */
export function buildWriteModel(
  content: Record<string, unknown>,
  deletedKeys: Set<string>,
): Record<string, unknown> {
  let result: Record<string, unknown> = JSON.parse(JSON.stringify(content));
  for (const path of deletedKeys) {
    if (parentSettable(result, path)) result = setPathValue(result, path, null);
  }
  return result;
}

export interface FoldedSettings {
  content: Record<string, unknown>;
  deletedKeys: Set<string>;
}

/**
 * 把 JSON 视图文本折叠回表单状态（切视图与保存共用，保证两边编辑互不丢失）：
 * - JSON `null` 叶子 = 恢复默认（删除该键）；
 * - 相对基线缺失的叶子键同样记为删除（JSON 视图按整文件语义编辑）；
 * - 类型变化吞并的删除不记标记（整值替换已覆盖）。
 * 解析失败 / 根节点非对象时返回 `{ error }`，调用方应拒绝切换或保存。
 */
export function foldJsonText(
  text: string,
  baseline: Record<string, unknown>,
): FoldedSettings | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: String(err) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'JSON 根节点必须是对象' };
  }
  const deletedKeys = new Set<string>();
  const stripNulls = (node: Record<string, unknown>, prefix: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value === null) {
        deletedKeys.add(path);
        continue;
      }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        out[key] = stripNulls(value as Record<string, unknown>, path);
        continue;
      }
      out[key] = value;
    }
    return out;
  };
  const content = stripNulls(parsed as Record<string, unknown>, '');

  const before = new Set<string>();
  collectLeafPaths(baseline, '', before);
  const after = new Set<string>();
  collectLeafPaths(content, '', after);
  for (const path of before) {
    if (after.has(path) || deletedKeys.has(path)) continue;
    // 祖先 / 后代成为叶子说明发生类型变化，删除标记会被整值替换吞并。
    let swallowed = false;
    for (const leaf of after) {
      if (leaf.startsWith(`${path}.`) || path.startsWith(`${leaf}.`)) {
        swallowed = true;
        break;
      }
    }
    if (!swallowed) deletedKeys.add(path);
  }
  return { content, deletedKeys };
}
