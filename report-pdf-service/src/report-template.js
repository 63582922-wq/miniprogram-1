function escapeHtml(value = "") {
  return `${value}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderText(value = "") {
  return escapeHtml(value).replace(/\n/g, "<br />");
}

function formatSlashDate(value = "") {
  if (!value) {
    return "";
  }
  return `${value}`.replace(/-/g, " / ");
}

function toChineseSectionNumber(value) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (value <= 10) {
    if (value === 10) {
      return "十";
    }
    return digits[value] || `${value}`;
  }
  if (value < 20) {
    return `十${digits[value - 10]}`;
  }
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${digits[tens]}十${ones ? digits[ones] : ""}`;
}

function groupItemsByImage(items = []) {
  const groups = [];
  const map = new Map();

  items.forEach((item, index) => {
    const primaryImage = (item.annotatedImages && item.annotatedImages[0]) || (item.images && item.images[0]) || "";
    const key = primaryImage || `source-${item.sourceIndex ?? index}`;
    if (!map.has(key)) {
      const group = {
        key,
        imageUrl: primaryImage,
        items: [],
        sourceIndex: item.sourceIndex ?? index,
        minOrder: item.order || index + 1
      };
      map.set(key, group);
      groups.push(group);
    }
    const group = map.get(key);
    group.minOrder = Math.min(group.minOrder, item.order || index + 1);
    group.items.push({
      ...item,
      order: item.order || index + 1
    });
  });

  return groups.sort((left, right) => {
    return (left.minOrder ?? 0) - (right.minOrder ?? 0);
  });
}

function chunkGroups(groups = [], size = 3) {
  const pages = [];
  for (let index = 0; index < groups.length; index += size) {
    pages.push(groups.slice(index, index + size));
  }
  return pages;
}

function resolveSeverityClass(value = "") {
  if (value === "critical") {
    return "issue__badge--critical";
  }
  if (value === "major") {
    return "issue__badge--major";
  }
  return "issue__badge--normal";
}

function renderSubIssue(item, index) {
  return `
    <article class="sub-issue">
      <div class="sub-issue__line">
        <span class="sub-issue__index">${item.subIssueIndex || index + 1}.</span>
        <span class="sub-issue__text">${renderText(item.description || "待补充")}</span>
      </div>
      <div class="sub-issue__meta">
        <span>${escapeHtml(item.severityText || "待定")}</span>
        <span>${escapeHtml(item.responsiblePartyText || "待确认")}</span>
        <span>${escapeHtml(item.area || "待确认区域")}</span>
        <span>${escapeHtml(item.category || "待确认分类")}</span>
      </div>
      <div class="sub-issue__suggestion"><span>建议：</span>${renderText(item.suggestion || "待补充")}</div>
    </article>
  `;
}

function renderGroup(group, index) {
  return `
    <section class="photo-group">
      <div class="photo-group__image-column">
        <div class="photo-group__group-title">问题 ${toChineseSectionNumber(index + 1)}</div>
        <div class="photo-group__image-wrap">
          <div class="photo-group__image-stage">
            ${group.imageUrl ? `<img class="photo-group__image" src="${group.imageUrl}" alt="巡查图片" />` : '<div class="photo-group__empty">暂无图片</div>'}
          </div>
        </div>
      </div>
      <div class="photo-group__issues">
        <div class="photo-group__issues-title">问题描述</div>
        <div class="photo-group__subissues">
          ${group.items.map(renderSubIssue).join("")}
        </div>
      </div>
    </section>
  `;
}

function buildReportHtml(report = {}) {
  const groups = groupItemsByImage(report.items || []);
  const pages = chunkGroups(groups, 3);
  return `<!DOCTYPE html>
  <html lang="zh-CN">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${escapeHtml(report.title || "巡查报告")}</title>
      <style>
        @page { size: A4; margin: 0; }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Zen Hei", sans-serif;
          color: #F5F5F5;
          background: #111111;
        }
        .page {
          width: 100%;
          min-height: 297mm;
          background: #111111;
          padding: 7mm 7mm 6mm;
          display: flex;
          flex-direction: column;
        }
        .page + .page {
          page-break-before: always;
        }
        .header {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 10px;
          align-items: start;
          padding: 1px 0 6px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        }
        .header__title {
          font-size: 18px;
          font-weight: 700;
          line-height: 1.3;
          margin-bottom: 6px;
          letter-spacing: 0.02em;
        }
        .header__meta {
          display: flex;
          align-items: center;
          gap: 26px;
          flex-wrap: wrap;
          font-size: 11px;
          color: #F5F5F5;
        }
        .header__meta-item {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          min-width: 0;
          white-space: nowrap;
        }
        .header__meta-label {
          color: #A3A3A3;
          font-weight: 600;
        }
        .header__meta-value {
          color: #F5F5F5;
        }
        .header__company {
          margin-top: 6px;
          font-size: 9px;
          line-height: 1.25;
          color: #D4D4D4;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 12px;
        }
        .header__company-item {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          min-width: 0;
        }
        .header__company-label {
          color: #A3A3A3;
          font-weight: 600;
          white-space: nowrap;
        }
        .header__company-value {
          color: #D4D4D4;
          word-break: break-all;
        }
        .header__logo {
          width: 68px;
          height: 68px;
          object-fit: contain;
          flex-shrink: 0;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.03);
          padding: 8px;
        }
        .summary {
          margin: 4px 0 6px;
          padding: 6px 8px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.025);
          font-size: 9px;
          line-height: 1.3;
          color: #D4D4D4;
        }
        .content {
          display: grid;
          grid-template-rows: repeat(3, minmax(0, 1fr));
          gap: 8px;
          flex: 1;
          min-height: 0;
        }
        .photo-group {
          display: grid;
          grid-template-columns: 68% minmax(0, 1fr);
          gap: 4px;
          page-break-inside: avoid;
          break-inside: avoid;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 10px;
          padding: 4px;
          background: rgba(255, 255, 255, 0.025);
          min-height: 0;
          height: 100%;
          align-items: start;
        }
        .photo-group__image-column {
          display: grid;
          grid-template-rows: auto auto;
          align-content: start;
          gap: 2px;
          min-width: 0;
          min-height: 0;
        }
        .photo-group__group-title {
          color: #F5F5F5;
          font-size: 11px;
          font-weight: 700;
          line-height: 1.2;
        }
        .photo-group__image-wrap {
          width: 100%;
          aspect-ratio: 16 / 9;
          min-height: 0;
          max-height: none;
          border-radius: 8px;
          overflow: hidden;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.08);
          padding: 0;
        }
        .photo-group__image-stage {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          background: rgba(255, 255, 255, 0.02);
        }
        .photo-group__image {
          width: 100%;
          height: 100%;
          object-fit: contain;
          object-position: center;
          display: block;
          background: transparent;
          border-radius: 0;
        }
        .photo-group__empty {
          color: #A3A3A3;
          font-size: 14px;
        }
        .photo-group__issues {
          display: grid;
          grid-template-rows: auto 1fr;
          gap: 1px;
          width: 92%;
          min-width: 0;
          min-height: 0;
          align-content: start;
          justify-self: start;
          margin-top: 15px;
        }
        .photo-group__issues-title {
          color: #F5F5F5;
          font-size: 12px;
          font-weight: 700;
        }
        .photo-group__subissues {
          display: flex;
          flex-direction: column;
          gap: 1px;
        }
        .sub-issue {
          padding-bottom: 1px;
          border-bottom: 1px dashed rgba(255, 255, 255, 0.12);
        }
        .sub-issue:last-child {
          border-bottom: 0;
          padding-bottom: 0;
        }
        .sub-issue__line {
          display: flex;
          align-items: flex-start;
          gap: 3px;
        }
        .sub-issue__index {
          min-width: 12px;
          color: #F5F5F5;
          font-size: 10px;
          font-weight: 700;
          line-height: 1.2;
        }
        .sub-issue__text {
          flex: 1;
          color: #F1F1F1;
          font-size: 9px;
          line-height: 1.25;
          font-weight: 600;
        }
        .sub-issue__meta {
          display: flex;
          flex-wrap: wrap;
          gap: 1px 3px;
          margin: 0 0 0 11px;
          color: #A3A3A3;
          font-size: 8px;
          line-height: 1.2;
        }
        .sub-issue__meta span::before {
          content: "· ";
        }
        .sub-issue__suggestion {
          margin: 0 0 0 11px;
          color: #D4D4D4;
          font-size: 8px;
          line-height: 1.2;
        }
        .sub-issue__suggestion span {
          color: #A3A3A3;
          font-weight: 600;
        }
        .footer {
          margin-top: 3px;
          padding-top: 3px;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          font-size: 7px;
          color: #A3A3A3;
          line-height: 1.1;
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 12px;
        }
        .footer__line {
          margin-bottom: 2px;
        }
        .footer__page {
          white-space: nowrap;
          color: #737373;
        }
        @media print {
          body {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
        }
      </style>
    </head>
    <body>
      ${pages.map((pageGroups, pageIndex) => `
      <main class="page">
        <section class="header">
          <div class="header__main">
            <div class="header__title">${escapeHtml(report.title || "巡查报告")} ${report.inspectionDate ? `/ ${escapeHtml(formatSlashDate(report.inspectionDate))}` : ""}</div>
            <div class="header__meta">
              <div class="header__meta-item"><span class="header__meta-label">项目：</span><span class="header__meta-value">${escapeHtml(report.projectName || "-")}</span></div>
              <div class="header__meta-item"><span class="header__meta-label">日期：</span><span class="header__meta-value">${escapeHtml(report.inspectionDate || "-")}</span></div>
              <div class="header__meta-item"><span class="header__meta-label">巡查员：</span><span class="header__meta-value">${escapeHtml(report.inspectorName || "-")}</span></div>
              <div class="header__meta-item"><span class="header__meta-label">联系方式：</span><span class="header__meta-value">${escapeHtml(report.inspectorPhone || "-")}</span></div>
            </div>
            ${(report.companyName || report.companyAddress)
              ? `<div class="header__company">
                  ${report.companyName ? `<div class="header__company-item"><span class="header__company-label">公司：</span><span class="header__company-value">${escapeHtml(report.companyName)}</span></div>` : ""}
                  ${report.companyAddress ? `<div class="header__company-item"><span class="header__company-label">地址：</span><span class="header__company-value">${escapeHtml(report.companyAddress)}</span></div>` : ""}
                </div>`
              : ""}
          </div>
          ${report.logoUrl ? `<img class="header__logo" src="${report.logoUrl}" alt="logo" />` : ""}
        </section>
        <section class="summary">
          ${renderText(report.contextNote || report.summary || "本报告由系统根据巡查结果自动整理生成。")}
        </section>
        <section class="content">
          ${pageGroups.map((group, groupIndex) => renderGroup(group, pageIndex * 3 + groupIndex)).join("")}
        </section>
        <footer class="footer">
          <div></div>
          <div class="footer__page">${pageIndex + 1} / ${pages.length || 1}</div>
        </footer>
      </main>
      `).join("")}
    </body>
  </html>`;
}

module.exports = {
  buildReportHtml
};
