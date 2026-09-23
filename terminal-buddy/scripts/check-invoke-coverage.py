#!/usr/bin/env python3
"""比对 Tauri 注册命令与桌面前端 invoke() 调用。

用法（仓库根的 terminal-buddy/ 下运行）：
    python scripts/check-invoke-coverage.py

解析规则：
- lib.rs 的 generate_handler![...] 用括号深度扫描提取（支持多行、嵌套）；
- 前端 invoke 用正则匹配 invoke(...) / invoke<T>(...) 的第一参数字符串字面量。
输出：前端调了但后端没注册（必须修复）、注册了但无桌面调用（需书面理由）。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIB_RS = ROOT / "src-tauri" / "src" / "lib.rs"
FRONTEND_DIRS = ["src/services", "src/components", "src/stores", "src/utils", "src/hooks", "src/data"]
FRONTEND_FILES = ["src/App.tsx"]


def extract_registered() -> set[str]:
    text = LIB_RS.read_text(encoding="utf-8")
    start = text.index("generate_handler![")
    depth = 0
    end = None
    for i in range(start, len(text)):
        ch = text[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = i
                break
    body = re.sub(r"//.*", "", text[start:end])
    # 跳过 "generate_handler![" 前缀，避免把宏名本身算进命令集合
    body = body.split("[", 1)[1]
    return {name for name in re.findall(r"\b([a-z_][a-z0-9_]*)\b", body) if name}


def extract_invokes() -> set[str]:
    calls: set[str] = set()
    files: list[Path] = []
    for d in FRONTEND_DIRS:
        files.extend((ROOT / d).rglob("*.ts"))
        files.extend((ROOT / d).rglob("*.tsx"))
    files.extend(ROOT / f for f in FRONTEND_FILES)
    for path in files:
        text = path.read_text(encoding="utf-8", errors="ignore")
        # 去掉行注释与块注释，避免「注释里提到 invoke('xxx')」被误计入调用
        text = re.sub(r"//[^\n]*", "", text)
        text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
        # invoke 的泛型参数可能是跨多行的复杂类型（嵌套 Array<...>、对象字面量、
        # 属性分隔符 `;`），不解析泛型本身：invoke 之后允许任意 400 字符内的内容，
        # 但第一个引号字符串必须是「参数列表的开始」（其后紧跟 , 或 )）。
        for m in re.finditer(
            r"\binvoke\s*[^'\"]{0,400}?['\"]([\w-]+)['\"\s]*[,)]", text, re.S
        ):
            calls.add(m.group(1))
    return calls


def main() -> int:
    registered = extract_registered()
    invokes = extract_invokes()
    missing = sorted(invokes - registered)
    extra = sorted(registered - invokes)
    print(f"registered: {len(registered)}, frontend invokes: {len(invokes)}")
    status = 0
    if missing:
        status = 1
        print("FAIL: frontend invokes missing registration:")
        for name in missing:
            print(f"  - {name}")
    else:
        print("OK: frontend invoke set is a subset of registrations")
    if extra:
        print("INFO: registered with no desktop invoke (keep with written reason):")
        for name in extra:
            print(f"  - {name}")
    return status


if __name__ == "__main__":
    sys.exit(main())
