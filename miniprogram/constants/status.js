const PROJECT_STATUS_OPTIONS = [
  { label: "进行中", value: "active" },
  { label: "已完工", value: "completed" },
  { label: "暂停中", value: "paused" }
];

/**
 * 问题等级 **只有三档**。
 *
 * 这里原本还有第四档「轻微」(minor)，但系统全链路只认 critical/major/normal：
 * 服务端 inspection 校验、AI 提示词与结果归一化、报告快照的 severityStats
 * 都是三档。于是用户选了「轻微」，页面显示「轻微」，存进报告却变成「一般」——
 * 静默改写，没有任何提示。
 *
 * 与其扩展一条贯穿 AI 提示词与报告结构的链路，不如让界面不提供
 * 系统承载不了的选项。tests/severity-options.test.cjs 会守住两边一致。
 */
const ISSUE_SEVERITY_OPTIONS = [
  { label: "严重", value: "critical", color: "#1A1814" },
  { label: "较重", value: "major", color: "#6B6355" },
  { label: "一般", value: "normal", color: "#B8A882" }
];

const RESPONSIBLE_PARTY_OPTIONS = [
  { label: "施工方", value: "constructor" },
  { label: "供应商", value: "supplier" },
  { label: "甲方", value: "client" },
  { label: "待确认", value: "pending" }
];

module.exports = {
  PROJECT_STATUS_OPTIONS,
  ISSUE_SEVERITY_OPTIONS,
  RESPONSIBLE_PARTY_OPTIONS
};
