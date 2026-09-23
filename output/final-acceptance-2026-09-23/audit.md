# 毫厘智管体验版 0.9.1 · 当前验收矩阵

日期：2026-09-23

## 当前结论

主链路在微信开发者工具和隔离数据中已经连续可操作：项目详情恢复同一草稿，进入准确照片，等待标注编辑器就绪，保存渲染图并返回，进入人工核对，退出后冷重开仍恢复同一项目、会话、照片和问题来源。已发布单份报告可重新打开，分享状态可在线复用、撤销和重建。

体验版 `0.9.1` 已上传，当前预览二维码已生成。没有提交公众审核或正式发布。

本文件不把模拟器冒充真机，也不把作者侧分享状态冒充第二账号接收。

## 要求与证据

| 要求 | 状态 | 权威证据 |
|---|---|---|
| 项目归属不串、主按钮直接恢复最近草稿 | 通过 | 当前连续点击复核：项目 ID `project-50768a216f7e6b9f972d132a2b1df6d4fbc21643`、会话 `inspection-create-muctvi9y-8hbxyfwc2h`、照片 `visual-audit-photo` 一致；`output/final-chain-01-capture-resumed.png` |
| 精准标注打开准确照片并等待 ready | 通过 | 当前连续点击复核；`output/final-chain-02-annotation-ready.png`；标注保存生成新的持久渲染路径并返回采集 |
| 人工核对保持照片与问题稳定关联 | 通过 | `issueGroups[0].key` 与问题 `sourcePhotoId` 均为 `visual-audit-photo`；`output/final-chain-03-review.png` |
| 退出后真实重开恢复 | 通过 | 冷重开项目详情后恢复相同 sessionKey 和 1 张照片；`output/final-chain-04-project-reopened.png` |
| 已发布单份报告重新打开 | 通过 | 报告 `report-deed1bdefd69fedfe1da84606f3085a9d1b9677b`，`snapshotVersion=2`、`publicationStatus=published`；`output/visual-convergence-2026-09-23-report-detail-paper.png` |
| 单报告分享不暴露列表或内部参数 | 通过 | 分享路径只含 `reportId` 与 `shareToken`；`output/runtime-account-delivery-audit/result.json` |
| 分享链接复用、撤销、重建 | 作者端线上通过 | 同一隔离报告真实调用：旧 active token 复用；撤销后 token 清空且状态 revoked；重建后生成不同 token 且状态恢复 active |
| 全局极简视觉体系 | 通过 | 暖纸 `#E9E4DD`、墨黑 `#191816`、朱橙 `#DE6E3F`；统一轮廓图标与双字体职责；`design-qa.md` |
| 项目、报告、我的三级导航状态 | 通过 | 三个一级页每次显示按路由同步；46 项回归中的导航测试及当前正式截图 |
| 体验版本 | 通过 | 上传版本 `0.9.1`，包大小 466616 bytes；预览二维码 `output/experience-build-2026-09-23/preview-0.9.1.png` |
| 自动与编译回归 | 通过 | 47/47；WXML 26、WXSS 29、JavaScript／JSON／原生模板均通过；交互母版三档宽度通过 |
| 公司资料、LOGO 与报告身份快照 | 线上隔离链路通过 | 测试 LOGO 上传后立即保存；退出重开恢复公司名、双方电话、地址、巡查人与 LOGO；新建零问题照片报告后六项资料进入冻结快照，正式报告页重开一致。证据：`output/final-acceptance-2026-09-23/company-identity-chain.json`、`company-settings-reopen.png`、`company-report-reopen.png`。取证后测试巡查／报告软删除、测试 LOGO 删除，账号资料恢复并再次读回确认 |
| 本机 PDF 鉴权、去重、生成、下载 | 通过 | 自动回归中的真实本机服务联调；离线 A4 版式样本已逐页检查 |
| 第二微信账号打开及撤销后旧链接失效 | 外部阻塞 | 开发者工具实时读取 `testAccounts()` 为空；没有第二微信身份，当前只能证明作者端线上状态和服务端隔离测试，不能伪造接收者结果 |
| 公网 PDF 从小程序提交并打开 | 外部阻塞 | 2026-09-23 复测：DNS 解析到 `49.232.215.168`；HTTP 302 到腾讯云 `webblock.html`，HTTPS `/health` 在握手后被重置。备案／公网 HTTPS 尚未就绪；在线报告不受影响 |
| iOS／Android 真机字体、触控、键盘、安全区、权限 | 未验证 | 已生成预览二维码，必须在真实设备记录结果；模拟器不能替代 |
| 真实 AI 与真实语音最小调用 | 未验证 | 需要先确认配置与计费边界；手动记录路径已通过 |

## 当前视觉证据

- 项目列表：`output/visual-convergence-2026-09-23-projects-paper.png`
- 项目详情：`output/visual-convergence-2026-09-23-detail-paper.png`
- 现场记录：`output/visual-convergence-2026-09-23-capture-paper.png`
- 精准标注：`output/visual-convergence-2026-09-23-annotation-paper.png`
- 人工核对：`output/visual-convergence-2026-09-23-review-paper.png`
- 报告列表：`output/visual-convergence-2026-09-23-reports-bottom-paper.png`
- 单份报告：`output/visual-convergence-2026-09-23-report-detail-paper.png`
- 我的：`output/visual-convergence-2026-09-23-profile-paper.png`
- 参考并排：`output/visual-convergence-2026-09-23-reference-vs-paper-final.png`

## 下一验收动作

1. 扫描 `output/experience-build-2026-09-23/preview-0.9.1.png`，在 iPhone 与 Android 各走一次“继续记录 → 标注 → 核对 → 返回重开”，记录机型、系统和失败点。
2. 用第二微信账号打开隔离报告；作者撤销后旧链接应失效，再生成新链接复测。
3. 备案与 HTTPS 就绪后只补公网 PDF 的提交、打开和按冻结快照重试，不重做界面。
4. 当前账号没有可恢复的真实公司资料；正式使用前由账号本人填写实际公司名、LOGO 与电话。保存、退出重开及新报告冻结链路已经用隔离资料线上通过，不需要重复做破坏性试验。

最终状态：体验版已具备主链路验收条件；外部设备、第二账号和公网 PDF 尚未完成，不能宣称正式发布验收通过。

## 当前外部阻塞的解除条件

1. 提供一个独立的第二微信账号或在开发者工具配置第二测试账号，用于只读分享、撤销失效与新链接恢复。
2. 用 iPhone 与 Android 各扫描现有体验版二维码，允许记录机型、系统、相机／相册／麦克风权限和操作结果。
3. 备案审核通过并解除腾讯云 WebBlock，`https://pdf.haolizhiguan.cn/health` 返回有效健康响应后，再进行公网 PDF 提交、打开和失败重试。
