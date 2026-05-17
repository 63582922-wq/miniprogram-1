const PROJECT_STATUS_OPTIONS = [
  { label: "进行中", value: "active" },
  { label: "已完工", value: "completed" },
  { label: "暂停中", value: "paused" }
];

const ISSUE_SEVERITY_OPTIONS = [
  { label: "严重", value: "critical", color: "#1A1814" },
  { label: "较重", value: "major", color: "#6B6355" },
  { label: "一般", value: "normal", color: "#B8A882" },
  { label: "轻微", value: "minor", color: "#D4C5A0" }
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
