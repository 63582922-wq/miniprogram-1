function formatDateTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");

  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function formatDate(value) {
  return formatDateTime(value).slice(0, 10);
}

function mapSeverityText(value) {
  const mapping = {
    critical: "严重",
    major: "较重",
    normal: "一般",
    minor: "轻微"
  };

  return mapping[value] || "待定";
}

function mapProjectStatusText(value) {
  const mapping = {
    active: "进行中",
    completed: "已完工",
    paused: "暂停中"
  };

  return mapping[value] || "进行中";
}

function mapResponsiblePartyText(value) {
  const mapping = {
    constructor: "施工方",
    supplier: "供应商",
    client: "甲方",
    pending: "待确认"
  };

  return mapping[value] || "待确认";
}

/**
 * 正整数转中文数字（1 → 一，11 → 十一，21 → 二十一）。
 *
 * 巡查报告的「问题 一 / 二 / 三」编号在三个地方用到：巡查结果确认页、
 * 报告页、PDF 模板。此前各处各写一份实现，报告页一度还改成阿拉伯数字 +
 * 1-A 的编号，导致同一份巡查出现两套编号。统一放这里，只此一份。
 */
function toChineseSectionNumber(value) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const num = Number(value);

  if (!Number.isFinite(num) || num <= 0) {
    return `${value}`;
  }
  if (num <= 10) {
    return num === 10 ? "十" : digits[num];
  }
  if (num < 20) {
    return `十${digits[num - 10]}`;
  }
  if (num < 100) {
    const tens = Math.floor(num / 10);
    const ones = num % 10;
    return `${digits[tens]}十${ones ? digits[ones] : ""}`;
  }
  return `${num}`;
}

module.exports = {
  formatDateTime,
  formatDate,
  mapSeverityText,
  mapProjectStatusText,
  mapResponsiblePartyText,
  toChineseSectionNumber
};
