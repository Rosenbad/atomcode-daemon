# [共创大赛] feat: Add AtomCode Daemon Integration

## 📋 项目简介

AtomCode Daemon 是一个基于 HTTP + SSE 的 API 服务，为 AtomCode AI 代理提供文件操作和 Shell 执行能力。它通过本地 CLI 模式与 AtomCode 无缝集成，无需额外配置即可直接使用。

## 🚀 核心功能

- **HTTP API** - 支持 SSE 流式响应的聊天接口
- **Web UI** - 浏览器端交互界面
- **CLI Mode** - 使用 atomcode CLI 无头模式，内置文件工具
- **API Mode** - 直接调用 OpenAI 兼容 API（支持 Vision 模型）
- **文件操作** - 10 种文件/Shell 操作（读、写、编辑、列表、搜索等）
- **会话管理** - 本地持久化对话历史
- **目录切换** - 可通过 UI 或 `/cd` 端点切换工作目录

## 🔧 技术实现

### 架构设计
```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Browser   │────▶│  AtomCode    │────▶│  atomcode   │
│   (UI)      │◀────│   Daemon     │◀────│    CLI      │
└─────────────┘     └──────────────┘     └─────────────┘
                      (127.0.0.1:18788)
```

### 关键特性
1. **自动配置读取** - 从 `~/.atomcode/config.toml` 自动读取配置
2. **热重载** - 配置文件修改后无需重启服务
3. **安全验证** - 路径验证、敏感路径检测、破坏性命令确认
4. **多 Provider 支持** - 支持所有在 config.toml 中定义的 AI 提供商

## 📦 安装与使用

```bash
# 克隆仓库
git clone https://github.com/Rosenbad/atomcode-daemon.git
cd atomcode-daemon

# 安装依赖
npm install

# 启动服务
npm start
```

访问 http://127.0.0.1:18788 即可使用。

## ✅ 参赛路线

本贡献属于 **路线三：创新架构师 (Innovative Architect)**

这是一个完整的系统级集成方案，解决了以下问题：
1. AtomCode CLI 的 Web 界面缺失问题
2. 文件操作的便捷性问题
3. 多 AI 提供商的统一接入问题

## 📝 项目结构

```
atomcode-daemon/
├── src/
│   ├── index.js          # 主服务器
│   ├── config.js         # 配置管理 + 热重载
│   ├── auth.js           # Token 认证
│   ├── store.js          # 会话存储
│   ├── engine.js         # AI 引擎 (CLI + API 双模式)
│   ├── tools.js          # 10 种文件/Shell 操作
│   └── web-ui.js         # 静态文件服务
├── public/
│   └── index.html        # Web UI
└── README.md             # 完整文档
```

## 🎯 价值说明

1. **提升开发效率** - 开发者可以通过浏览器直接与 AtomCode 交互，无需命令行
2. **增强文件操作** - 内置的文件工具让代码审查、编辑更加便捷
3. **降低使用门槛** - 开箱即用，无需复杂配置
4. **扩展性强** - 支持添加更多工具和 Providers

## 📄 许可证

MIT License

---

**Contributor**: Rosenbad  
**Date**: 2026-05-12  
**Repository**: https://atomgit.com/2201_75613960/AtomCode-021
