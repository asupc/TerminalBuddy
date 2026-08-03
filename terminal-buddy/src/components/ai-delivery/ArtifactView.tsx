import { useCallback, useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { ArrowLeftRight, Download, FileText } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  exportAiDeliveryArtifactsZip,
  listAiDeliveryArtifacts,
  readAiDeliveryArtifact,
} from "../../services/tauri";
import type { AiArtifactMeta, AiDelivery } from "../../types/aiDelivery";
import { classifyAiError } from "./utils/aiError";

/** 产物文件语言推断：按扩展名映射 Monaco 语言。 */
function artifactLanguage(path: string): string {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".log") || path.endsWith(".txt")) return "plaintext";
  return "plaintext";
}

/** 可读文件大小（B/KB/MB）。 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

interface ArtifactViewProps {
  delivery: AiDelivery;
  /** 其它交付（用于跨交付 plan.json 对比） */
  deliveries: AiDelivery[];
}

/** 产物归档 Tab：文件浏览/预览 + 跨交付 plan.json 对比（Monaco Diff）+ ZIP 打包下载。 */
export function ArtifactView({ delivery, deliveries }: ArtifactViewProps) {
  const [artifacts, setArtifacts] = useState<AiArtifactMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [compareDeliveryId, setCompareDeliveryId] = useState("");
  const [comparePath, setComparePath] = useState("plan.json");
  const [leftContent, setLeftContent] = useState("");
  const [rightContent, setRightContent] = useState("");
  const [compareError, setCompareError] = useState("");
  const [busy, setBusy] = useState("");
  const [zipError, setZipError] = useState("");

  const loadArtifacts = useCallback(() => {
    setLoading(true);
    void listAiDeliveryArtifacts(delivery.id)
      .then((items) => {
        setArtifacts(items);
        if (items.length > 0 && previewPath === null) setPreviewPath(items[0].path);
      })
      .catch((reason) => setPreviewError(classifyAiError(reason).message))
      .finally(() => setLoading(false));
  }, [delivery.id, previewPath]);

  useEffect(() => {
    loadArtifacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delivery.id]);

  // 预览当前选中产物
  useEffect(() => {
    if (!previewPath) return;
    setPreviewError("");
    void readAiDeliveryArtifact(delivery.id, previewPath)
      .then(setPreviewContent)
      .catch((reason) => setPreviewError(classifyAiError(reason).message));
  }, [delivery.id, previewPath]);

  // 对比：本交付 plan.json vs 目标交付的对应产物
  const runCompare = useCallback(() => {
    if (!compareDeliveryId) return;
    setCompareError("");
    setBusy("compare");
    void Promise.all([
      readAiDeliveryArtifact(delivery.id, comparePath),
      readAiDeliveryArtifact(compareDeliveryId, comparePath),
    ])
      .then(([left, right]) => {
        setLeftContent(left);
        setRightContent(right);
      })
      .catch((reason) => setCompareError(classifyAiError(reason).message))
      .finally(() => setBusy(""));
  }, [delivery.id, compareDeliveryId, comparePath]);

  const exportZip = async () => {
    setZipError("");
    const selected = await save({
      title: "导出交付产物 ZIP",
      defaultPath: `delivery-${delivery.title || delivery.id}.zip`,
      filters: [{ name: "ZIP 归档", extensions: ["zip"] }],
    });
    if (!selected) return; // 用户取消
    setBusy("zip");
    try {
      await exportAiDeliveryArtifactsZip(delivery.id, selected);
    } catch (reason) {
      setZipError(classifyAiError(reason).message);
    } finally {
      setBusy("");
    }
  };

  const planFiles = artifacts.filter((item) => item.path.endsWith("plan.json"));
  const comparePlanPath = planFiles[0]?.path ?? "plan.json";

  return (
    <div className="ai-artifact-view">
      <div className="ai-artifact-toolbar">
        <span className="ai-artifact-count">产物 {artifacts.length} 项</span>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void exportZip()}
          disabled={busy === "zip" || artifacts.length === 0}
        >
          <Download size={14} />
          {busy === "zip" ? "打包中..." : "打包下载 ZIP"}
        </button>
        {zipError && <span className="ai-artifact-error">{zipError}</span>}
      </div>

      {loading ? (
        <p className="ai-artifact-empty">正在扫描产物目录...</p>
      ) : artifacts.length === 0 ? (
        <p className="ai-artifact-empty">该交付暂无产物文件（Agent 运行后自动生成）。</p>
      ) : (
        <div className="ai-artifact-layout">
          <ul className="ai-artifact-list">
            {artifacts.map((item) => (
              <li key={item.path}>
                <button
                  type="button"
                  className={previewPath === item.path ? "active" : ""}
                  onClick={() => setPreviewPath(item.path)}
                >
                  <FileText size={13} />
                  <span className="ai-artifact-path">{item.path}</span>
                  <small>{formatSize(item.size)}</small>
                </button>
              </li>
            ))}
          </ul>
          <div className="ai-artifact-preview">
            {previewError && <p className="ai-artifact-error">{previewError}</p>}
            {previewPath && !previewError && (
              <pre className="ai-artifact-pre">{previewContent}</pre>
            )}
          </div>
        </div>
      )}

      <section className="ai-artifact-compare" aria-label="跨交付产物对比">
        <div className="ai-artifact-compare-heading">
          <ArrowLeftRight size={15} />
          <strong>跨交付对比（plan.json）</strong>
          <select
            value={compareDeliveryId}
            onChange={(event) => setCompareDeliveryId(event.target.value)}
            title="选择要对比的交付"
          >
            <option value="">选择另一交付...</option>
            {deliveries
              .filter((item) => item.id !== delivery.id)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title || item.id}
                </option>
              ))}
          </select>
          <select
            value={comparePath}
            onChange={(event) => setComparePath(event.target.value)}
            title="对比产物文件"
          >
            <option value="plan.json">plan.json</option>
            {planFiles.length > 1 && planFiles.map((item) => (
              <option key={item.path} value={item.path}>{item.path}</option>
            ))}
          </select>
          <button
            type="button"
            className="btn-secondary"
            onClick={runCompare}
            disabled={!compareDeliveryId || busy === "compare"}
          >
            {busy === "compare" ? "对比中..." : "开始对比"}
          </button>
        </div>
        {compareError && <p className="ai-artifact-error">{compareError}</p>}
        {leftContent && rightContent && (
          <div className="ai-artifact-diff">
            <DiffEditor
              language={artifactLanguage(comparePlanPath)}
              original={leftContent}
              modified={rightContent}
              height="400px"
              theme="vs-dark"
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 13,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                renderSideBySide: true,
                originalEditable: false,
              }}
            />
          </div>
        )}
      </section>
    </div>
  );
}
