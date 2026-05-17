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

module.exports = {
  formatDateTime,
  formatDate,
  mapSeverityText,
  mapProjectStatusText,
  mapResponsiblePartyText
};
