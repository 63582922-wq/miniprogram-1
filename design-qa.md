# 毫厘智管全局视觉收敛设计 QA

## 对照对象

- 视觉方向参考：`/Users/cft/.codex/generated_images/01a0beb8-0d68-7c40-8fb2-8708869a982a/exec-40b154de-53fd-4413-be21-82ee16ccc3b4.png`
- 正式项目页：`/Users/cft/WeChatProjects/miniprogram-1/output/visual-convergence-2026-09-23-projects-paper.png`
- 正式项目详情：`/Users/cft/WeChatProjects/miniprogram-1/output/visual-convergence-2026-09-23-detail-paper.png`
- 正式现场记录：`/Users/cft/WeChatProjects/miniprogram-1/output/visual-convergence-2026-09-23-capture-paper.png`
- 正式精准标注：`/Users/cft/WeChatProjects/miniprogram-1/output/visual-convergence-2026-09-23-annotation-paper.png`
- 正式人工核对：`/Users/cft/WeChatProjects/miniprogram-1/output/visual-convergence-2026-09-23-review-paper.png`
- 正式报告列表：`/Users/cft/WeChatProjects/miniprogram-1/output/visual-convergence-2026-09-23-reports-bottom-paper.png`
- 正式单份报告：`/Users/cft/WeChatProjects/miniprogram-1/output/visual-convergence-2026-09-23-report-detail-paper.png`
- 正式我的：`/Users/cft/WeChatProjects/miniprogram-1/output/visual-convergence-2026-09-23-profile-paper.png`
- 同尺寸并排对照：`/Users/cft/WeChatProjects/miniprogram-1/output/visual-convergence-2026-09-23-reference-vs-paper-final.png`

## 规格与状态

- 视觉参考：853 × 1844 px。
- 正式截图：732 × 1586 px，微信开发者工具 iPhone 模拟器运行态。
- 并排图将双方等比缩放／补边到 732 × 1586 px；只比较视觉语言、内容层级、字体职责、照片比例和操作优先级，不比较状态栏像素。
- 正式状态使用隔离项目 `QA-0922-B`，包含真实已保存照片、未完成草稿及已发布报告。

## 最终视觉契约

- 颜色：暖纸 `#E9E4DD`、输入面 `#F2EEE8`、中性墨 `#191816`、朱橙 `#DE6E3F`、分隔 `#C9C1B7`、照片留白 `#DDD6CC`。正式界面、Logo、应用图标、标注画布与 PDF 不再使用墨绿色相。
- 字体：只保留两种职责。中文对象标题和报告封面使用宋体；导航、按钮、列表、表单、说明、数字及纯英文／编号标题使用苹方或系统黑体。
- 图标：一级导航全部使用同线宽的轮廓图标。当前项由墨黑文字、墨黑图标和朱橙短线共同表达，不再使用实心图标、白色图标或墨绿底块。
- 布局：页面使用连续纸面与细分隔，不使用层层卡片；首屏只保留当前对象、照片主体、状态和一个主操作。
- 动作：朱橙只用于开始记录、进入核对、保存标注等主操作及标注当前工具，不承担大面积装饰。

## 对照结论

- 项目详情已形成“项目名 → 最近照片 → 照片说明 → 记录进度 → 单一主操作”的连续阅读顺序，与参考方向一致。
- 项目一级页、报告列表和“我的”共用同一产品识别、纸色、字体层级、图标线宽和底栏反馈，不再像三套独立页面。
- 现场记录把照片作为主内容；精准标注把画布空间让给照片，工具选中态只用朱橙线条和文字，不再出现深色工具条或大块主题底。
- 报告列表滚到底后最后一项完全位于固定底栏上方，内容可达；安全区没有遮挡主操作。
- `QA-0922-B` 等纯英文／编号对象名使用系统黑体，避免出现类似 Times 的错误观感；中文照片标题和“现场记录中”继续使用确认稿的编辑式宋体。

## 修复历史

1. P1：一级导航选中图标使用实心几何，而未选中使用轮廓，图标语言不一致。
   - 修复：三个选中图标全部改为与未选中态相同轮廓，仅改变墨色和朱橙短线。
2. P1：纯英文／编号项目名被强制套用宋体，运行态出现类似 Times 的字形。
   - 修复：按内容判断字体；含中文的对象标题使用展示宋体，其余使用系统黑体。
3. P2：一级页同时出现品牌抬头和超大“项目／报告／我的”，层级重复。
   - 修复：改为紧凑的“全部项目／全部报告／账户与报告资料”，业务动作进入内容区。
4. P1：正式页虽移除墨绿，却仍使用比参考更白的纸色和偏红的旧橙色，母版、标注与 PDF 之间也有旧回退值。
   - 修复：统一为本文件的六个最终色值；更新 SVG、PNG、原生样式、画布和 PDF，并加入禁止旧墨绿值回流的测试。

## 有意保留的差异

- 参考图底栏当前图标带墨绿色。用户已明确否定这一颜色，因此正式实现不照搬，改为中性墨黑轮廓＋朱橙短线。
- 参考图按钮为白色文字和图标。用户此前明确指出白色图标不合适，因此正式主按钮使用墨黑图标和文字，保证图标与全局线性系统一致。
- 参考图是一级项目主页；正式产品保留项目列表 → 项目详情的已确认信息架构，所以详情页有返回导航，底部三栏仅出现在一级页。

## 验证

- 46 项自动测试通过。
- 26 个 WXML、29 个 WXSS 通过原生编译；JavaScript、JSON 和原生模板检查通过。
- 交互母版在 320、375、430 三种宽度通过，无脚本错误。
- 项目、详情、记录、标注、人工核对、报告列表、单份报告和我的均从正式小程序重新打开并截图复核。
- 体验版 `0.9.1` 已上传；本轮没有提交公开审核或正式发布。
- 尚未替代真机结论：Android 宋体回退、实体键盘／软键盘、安全区和真实双指手势仍需双平台真机确认。

final result: passed
