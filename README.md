# 毫厘智管

原生微信小程序：项目 → 现场记录与精准标注 → AI 整理或手动整理 → 人工核对 → 在线报告与 PDF。

## A「精密工程」实施状态

正式代码与本地隔离检查已推进，尚未部署和通过真机体验版验收；不能将设计母版视为可发布客户端。

- [当前交付状态](docs/redesign-2026-09-20/交付状态-A.md)
- [实施计划与剩余工作](docs/redesign-2026-09-20/实施计划-A.md)
- [验收记录](docs/redesign-2026-09-20/验收记录-A.md)
- [部署与回退](docs/redesign-2026-09-20/部署与回退-A.md)

本地检查：`node tests/local-compile.cjs` 与 `node --test tests/*.test.cjs`。隔离测试不调用真实云端或收费模型。

## 原始云开发 quickstart

这是云开发的快速启动指引，其中演示了如何上手使用云开发的三大基础能力：

- 数据库：一个既可在小程序前端操作，也能在云函数中读写的 JSON 文档型数据库
- 文件存储：在小程序前端直接上传/下载云端文件，在云开发控制台可视化管理
- 云函数：在云端运行的代码，微信私有协议天然鉴权，开发者只需编写业务逻辑代码

## 参考文档

- [云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)
