# TerminalBuddy 文档中心

本目录统一收口项目的使用指南、功能设计规范、实施计划与技术调研；纯静态 HTML 交互原型与视觉稿放在 [`design/`](../design/README.md)。

## 目录结构

| 目录 | 定位 |
| --- | --- |
| [`guides/`](guides/) | 面向用户与开发者的使用手册、配置指南、部署说明与 API 协议 |
| [`specs/`](specs/) | 各模块功能设计规范与架构边界说明 |
| [`plans/`](plans/) | 分阶段实施计划、依赖升级与验证方案 |
| [`research/`](research/) | 方案调研、问题根因分析与可行性评估 |
| [`images/`](images/) | README 与使用文档配图及演示动图 |

## 1. 使用与 API 指南（`guides/`）

- [完整使用与配置指南](guides/完整使用与配置指南.md)
- [使用技巧速查](guides/使用技巧.md)
- [Docker 与完整网页界面](guides/Docker与完整网页界面.md)
- [原生 AI 会话 API](guides/原生AI会话API.md)
- [桌面端远程工作区](guides/桌面端远程工作区.md)

## 2. 功能设计规范（`specs/`）

- [Android AI 对话 Markdown 渲染设计（2026-10-23）](specs/2026-10-23--android-ai-markdown-design.md)
- [终端 Agent 会话接力协议（2026-11-01）](specs/2026-11-01--terminal-agent-chat-relay.md)
- [Android 进行中标签合并设计（2026-11-02）](specs/2026-11-02--android-ongoing-tab-merge.md)
- [桌面端对话式聊天体验设计（2026-11-07）](specs/2026-11-07--desktop-conversational-chat.md)
- [Claude 终端增强设计](specs/claude-terminal-enhancement.md)（原型：[`design/claude-terminal-enhancement/index.html`](../design/claude-terminal-enhancement/index.html)）
- [定时任务功能设计](specs/scheduled-tasks.md)（原型：[`design/scheduled-tasks/preview.html`](../design/scheduled-tasks/preview.html)）
- [移动端会话页重构设计](specs/android-sessions-redesign.md)（原型：[`design/sessions-redesign/index.html`](../design/sessions-redesign/index.html)）
- [设置中心重构设计](specs/settings-redesign.md)（原型：[`design/settings-redesign/index.html`](../design/settings-redesign/index.html)）
- [终端任务摘要设计](specs/terminal-task-summary.md)

## 3. 实施与升级计划（`plans/`）

- [定时任务实施计划](plans/scheduled-tasks-implementation-plan.md)
- [第三方依赖升级与验证计划（2026-11-13）](plans/2026-11-13--third-party-dependency-upgrade-and-validation-plan.md)

## 4. 技术调研与分析（`research/`）

- [Android AI 对话上下文与 Token 状态栏调研](research/Android%20AI对话上下文与Token状态栏调研.md)
- [Android 原生终端版本方案调研](research/Android原生终端版本方案调研.md)
- [安卓后台通知分析与修复](research/安卓后台通知分析.md)

## 5. 仓库根目录核心文档

- [README（English）](../README.md) / [README（中文）](../README_zh.md)
- [部署说明](../DEPLOY_README.md)
- [变更日志](../CHANGELOG.md)
- [版本管理指南](../VERSION_GUIDE.md) / [版本特性汇总](../VERSION_FEATURE_SUMMARY.md)
- [Android 客户端说明](../android/README.md)
- [协作与工程规范（AGENTS.md）](../AGENTS.md)
