# report-pdf-service

毫厘智管的现有 Puppeteer PDF 服务。A 版本采用浅白纸面、石墨文字和清楚的照片分组；编号为“问题 一 / 1. / 2.”。照片优先使用已导出的标注图，零问题照片保留，长文自然分页。

2026-09-21：新版已在原服务器受控切换，旧服务及 PM2 配置已备份。隔离验收通过健康检查、401 鉴权拒绝、稳定任务 ID、异步生成、PDF 下载和公开预览；样本本地视觉复核、公网 HTTPS、云函数到服务的真实调用仍未通过。详情见 [现场记录](../docs/redesign-2026-09-20/live-acceptance-0921/记录.md)。完整顺序、费用检查和回退门槛见 [部署与回退-A](../docs/redesign-2026-09-20/部署与回退-A.md)。

## 启动前

安装本目录 package.json 中的既有依赖，确认 Chromium 与中文字体可用。通过服务管理器配置 PDF_API_KEY；未配置时进程拒绝启动。不要在客户端或日志中放置密钥。

默认端口 3100；可设置 PORT。可用 PUPPETEER_EXECUTABLE_PATH 指定已安装的浏览器。图片只允许可信 HTTPS 云存储域名；PDF_ALLOWED_IMAGE_HOSTS 只能补确有需要的可信域名。

## 接口

除 GET /health 外，所有生成、状态与下载请求都要求请求头 X-API-Key。请求体为服务端根据报告冻结快照组装的内容，不能信任客户端临时页面数据。

|方法与路径|用途|
|---|---|
|GET /health|健康状态，不证明生成链路成功|
|POST /api/report-pdf/tasks|异步创建，返回任务状态|
|GET /api/report-pdf/tasks/:taskId|查询原任务|
|GET /api/report-pdf/tasks/:taskId/download|成功后取 PDF 文件|
|POST /api/report-pdf/generate|保留原同步生成兼容入口|

异步输入在 title、photos、items 等快照字段之外可带 jobId，格式为 pdf- 后接 40 位十六进制字符。云端必须在发起 HTTP 前存好同一个 ID；同进程重复请求返回同一任务。photos.id 与 items.sourcePhotoId 关联，不依赖图片 URL 唯一性。

任务状态为 queued/running/success/failed。队列仍保存在服务进程内存；重启会丢失任务，查询返回 404。云端 report 函数把这种情况变成明确失败，允许以同一冻结快照重试新的尝试，不无限等待，也不改变已经发表的在线报告。

已完成任务的临时文件按既有 TTL 回收；报告最终文件由云端保存到云存储。请保留实际服务版本和部署包用于回退，不能拿本机离线打印替代服务验收。

## 本地版式检查

项目根目录的 tests/pdf-layout.cjs 使用实际模板和本机 Chrome/Playwright 离线输出隔离样本；不是调用本服务。输出位于 output/pdf/precision-A-isolated-sample.pdf。样本图片为设计演示素材，不是真实现场记录。

实际服务验收还必须覆盖图片不可读、服务重启、鉴权拒绝、中文字体、生成后微信打开和同一快照的内容对应；结果记录在验收台账。
