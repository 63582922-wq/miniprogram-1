const PDF_PAGE_WIDTH = 595;
const PDF_PAGE_HEIGHT = 842;
const CANVAS_WIDTH = 1240;
const CANVAS_HEIGHT = Math.round(CANVAS_WIDTH * PDF_PAGE_HEIGHT / PDF_PAGE_WIDTH);

const PAGE_BACKGROUND = "#06070A";
const TEXT_PRIMARY = "#F8FAFC";
const TEXT_SECONDARY = "rgba(248, 250, 252, 0.68)";
const STROKE_STRONG = "rgba(248, 250, 252, 0.42)";
const STROKE_SOFT = "rgba(248, 250, 252, 0.18)";
const PANEL_BACKGROUND = "rgba(255, 255, 255, 0.02)";
const IMAGE_PLACEHOLDER = "rgba(255, 255, 255, 0.04)";
const FRAME_X = 88;
const FRAME_Y = 126;
const FRAME_WIDTH = CANVAS_WIDTH - FRAME_X * 2;
const FRAME_HEIGHT = CANVAS_HEIGHT - 238;
const INNER_PADDING_X = 46;
const INNER_PADDING_Y = 36;
const SLOT_GAP = 22;
const HEADER_HEIGHT = 122;
const PAGE_BOTTOM_META_HEIGHT = 34;
const PHOTO_WIDTH = 520;
const DETAIL_GAP = 22;
const LOGO_TOP_Y = 24;
const LOGO_BOTTOM_Y = CANVAS_HEIGHT - 72;
const SIDE_LOGO_OFFSET_X = 30;
const TOP_LOGO_MAX_WIDTH = 196;
const TOP_LOGO_MAX_HEIGHT = 56;
const SIDE_LOGO_MAX_WIDTH = 164;
const SIDE_LOGO_MAX_HEIGHT = 50;
const GROUP_MIN_HEIGHT = 220;
const GROUP_MAX_HEIGHT = 520;

function asciiBytes(text = "") {
  const buffer = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    buffer[index] = text.charCodeAt(index) & 0xFF;
  }
  return buffer;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.length;
  });
  return output;
}

function wrapCanvasText(ctx, text = "", maxWidth) {
  const paragraphs = `${text || ""}`.split("\n");
  const lines = [];

  paragraphs.forEach((paragraph) => {
    if (!paragraph.trim()) {
      lines.push("");
      return;
    }

    let current = "";
    for (const char of paragraph) {
      const next = `${current}${char}`;
      if (current && ctx.measureText(next).width > maxWidth) {
        lines.push(current);
        current = char;
      } else {
        current = next;
      }
    }
    if (current) {
      lines.push(current);
    }
  });

  return lines.length ? lines : [""];
}

function limitLines(ctx, text, maxWidth, maxLines) {
  const lines = wrapCanvasText(ctx, text, maxWidth);
  if (lines.length <= maxLines) {
    return lines;
  }

  const clipped = lines.slice(0, maxLines);
  let last = clipped[maxLines - 1];
  while (last && ctx.measureText(`${last}…`).width > maxWidth) {
    last = last.slice(0, -1);
  }
  clipped[maxLines - 1] = `${last}…`;
  return clipped;
}

function setTextStyle(ctx, size, weight, color, align = "left") {
  ctx.font = `${weight} ${size}px sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
}

function drawLines(ctx, lines, x, y, lineHeight) {
  lines.forEach((line, index) => {
    ctx.fillText(line, x, y + index * lineHeight);
  });
}

function fitInlineText(ctx, prefix, value, maxWidth) {
  const safeValue = value || "-";
  let output = `${prefix}${safeValue}`;
  if (ctx.measureText(output).width <= maxWidth) {
    return output;
  }

  let trimmed = safeValue;
  while (trimmed && ctx.measureText(`${prefix}${trimmed}…`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${prefix}${trimmed || safeValue.slice(0, 1)}…`;
}

function drawRoundedRect(ctx, x, y, width, height, radius, fillColor = "", strokeColor = "") {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  if (fillColor) {
    ctx.fillStyle = fillColor;
    ctx.fill();
  }
  if (strokeColor) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

async function resolveFileToLocalPath(filePath = "") {
  if (!filePath) {
    return "";
  }

  if (filePath.startsWith("cloud://")) {
    const result = await wx.cloud.downloadFile({
      fileID: filePath
    });
    return result.tempFilePath || "";
  }

  if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
    const info = await wx.getImageInfo({
      src: filePath
    });
    return info.path || filePath;
  }

  return filePath;
}

function loadCanvasImage(canvas, src) {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function buildItemAssets(report) {
  const logoPath = await resolveFileToLocalPath(report.logoFileId || "");
  const items = await Promise.all((report.items || []).map(async (item) => {
    const imageSource = (item.annotatedImages && item.annotatedImages[0])
      || (item.images && item.images[0])
      || "";
    if (!imageSource) {
      return {
        ...item,
        reportImagePath: "",
        reportImageWidth: 0,
        reportImageHeight: 0,
        reportImageSourceType: "raw"
      };
    }

    try {
      const localPath = await resolveFileToLocalPath(imageSource);
      const info = await wx.getImageInfo({
        src: localPath
      });
      return {
        ...item,
        reportImagePath: info.path || localPath,
        reportImageWidth: info.width || 0,
        reportImageHeight: info.height || 0,
        reportImageSourceType: imageSource === item.images?.[0] ? "raw" : "annotated"
      };
    } catch (error) {
      return {
        ...item,
        reportImagePath: "",
        reportImageWidth: 0,
        reportImageHeight: 0,
        reportImageSourceType: "raw"
      };
    }
  }));

  return {
    logoPath,
    items
  };
}

function estimateIssueSummaryHeight(ctx, item, detailWidth) {
  const detailInnerWidth = detailWidth - 44;
  let contentHeight = 26;

  setTextStyle(ctx, 14, 500, TEXT_PRIMARY);
  contentHeight += 3 * 22;

  setTextStyle(ctx, 14, 400, TEXT_PRIMARY);
  const descLines = limitLines(ctx, item.description || "待补充", detailInnerWidth - 52, 2);
  const suggestionLines = limitLines(ctx, item.suggestion || "待补充", detailInnerWidth - 52, 2);
  contentHeight += descLines.length * 18 + 10;
  contentHeight += suggestionLines.length * 18 + 8;

  if (item.visualEvidence) {
    const evidenceLines = limitLines(ctx, item.visualEvidence, detailInnerWidth - 64, 1);
    contentHeight += evidenceLines.length * 16 + 6;
  }

  return contentHeight;
}

function buildImageGroups(items = []) {
  const groups = [];
  const groupMap = new Map();

  items.forEach((item, index) => {
    const key = Number.isInteger(item.sourceIndex)
      ? `source-${item.sourceIndex}`
      : item.reportImagePath
        ? `image-${item.reportImagePath}`
        : `item-${index}`;

    if (!groupMap.has(key)) {
      const nextGroup = {
        key,
        sourceIndex: Number.isInteger(item.sourceIndex) ? item.sourceIndex : index,
        reportImagePath: item.reportImagePath || "",
        reportImageWidth: item.reportImageWidth || 0,
        reportImageHeight: item.reportImageHeight || 0,
        annotations: Array.isArray(item.annotations) ? item.annotations : [],
        reportImageSourceType: item.reportImageSourceType || "raw",
        items: []
      };
      groupMap.set(key, nextGroup);
      groups.push(nextGroup);
    }

    groupMap.get(key).items.push({
      ...item,
      reportOrder: index
    });
  });

  return groups.map((group) => ({
    ...group,
    items: group.items.sort((left, right) => left.reportOrder - right.reportOrder)
  }));
}

function estimateGroupRowHeight(ctx, group, detailWidth) {
  let contentHeight = 26;
  group.items.forEach((item, index) => {
    contentHeight += 30;
    contentHeight += estimateIssueSummaryHeight(ctx, item, detailWidth);
    contentHeight += index === group.items.length - 1 ? 16 : 18;
  });

  return Math.max(GROUP_MIN_HEIGHT, Math.min(GROUP_MAX_HEIGHT, contentHeight));
}

function buildPages(groups, ctx) {
  const pages = [];
  const detailWidth = FRAME_WIDTH - INNER_PADDING_X * 2 - PHOTO_WIDTH - DETAIL_GAP;
  const availableHeight = FRAME_HEIGHT - HEADER_HEIGHT - PAGE_BOTTOM_META_HEIGHT;
  let currentGroups = [];
  let currentLayouts = [];
  let usedHeight = 0;

  groups.forEach((group) => {
    const rowHeight = estimateGroupRowHeight(ctx, group, detailWidth);
    const nextUsedHeight = currentGroups.length ? usedHeight + SLOT_GAP + rowHeight : rowHeight;
    const pageHasContent = currentGroups.length > 0;

    if (pageHasContent && nextUsedHeight > availableHeight) {
      pages.push({
        groups: currentGroups,
        layouts: currentLayouts
      });
      currentGroups = [];
      currentLayouts = [];
      usedHeight = 0;
    }

    currentGroups.push(group);
    currentLayouts.push({
      rowHeight
    });
    usedHeight = currentGroups.length === 1 ? rowHeight : usedHeight + SLOT_GAP + rowHeight;
  });

  if (currentGroups.length || !pages.length) {
    pages.push({
      groups: currentGroups,
      layouts: currentLayouts
    });
  }

  return pages;
}

function clearCanvas(ctx) {
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.fillStyle = PAGE_BACKGROUND;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
}

function formatDateParts(dateValue) {
  const raw = dateValue ? new Date(dateValue) : new Date();
  if (Number.isNaN(raw.getTime())) {
    return {
      year: "",
      month: "",
      day: ""
    };
  }
  return {
    year: `${raw.getFullYear()}`,
    month: `${raw.getMonth() + 1}`.padStart(2, "0"),
    day: `${raw.getDate()}`.padStart(2, "0")
  };
}

function drawBrandText(ctx, text, x, y, rotate = 0, size = 30) {
  ctx.save();
  ctx.translate(x, y);
  if (rotate) {
    ctx.rotate(rotate);
  }
  setTextStyle(ctx, size, 500, TEXT_PRIMARY, "center");
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

async function drawBrandMark(ctx, canvas, logoPath, fallbackText, centerX, topY, maxWidth, maxHeight, rotate = 0) {
  ctx.save();
  ctx.translate(centerX, topY);
  if (rotate) {
    ctx.rotate(rotate);
  }
  if (logoPath) {
    try {
      const image = await loadCanvasImage(canvas, logoPath);
      const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
      const width = image.width * scale;
      const height = image.height * scale;
      ctx.drawImage(image, -width / 2, 0, width, height);
      ctx.restore();
      return;
    } catch (error) {
    }
  }
  setTextStyle(ctx, 42, 500, TEXT_PRIMARY, "center");
  ctx.fillText(fallbackText || "LOGO", 0, 6);
  ctx.restore();
}

function drawMetaCell(ctx, label, value, x, y, width, subValue = "") {
  setTextStyle(ctx, 16, 500, TEXT_SECONDARY);
  ctx.fillText(label, x, y);
  setTextStyle(ctx, 20, 500, TEXT_PRIMARY);
  const lines = limitLines(ctx, value || "-", width, 1);
  ctx.fillText(lines[0], x, y + 22);
  if (subValue) {
    setTextStyle(ctx, 15, 400, TEXT_SECONDARY);
    const subLines = limitLines(ctx, subValue, width, 1);
    ctx.fillText(subLines[0], x, y + 46);
  }
}

function computeImageFit(width, height, maxWidth, maxHeight) {
  if (!width || !height) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  };
}

function getAnnotationBounds(annotations = []) {
  let maxX = 760;
  let maxY = 540;
  annotations.forEach((item) => {
    if (item.tool === "box") {
      maxX = Math.max(maxX, (item.x || 0) + (item.width || 0) + 24);
      maxY = Math.max(maxY, (item.y || 0) + (item.height || 0) + 24);
      return;
    }
    if (item.tool === "arrow") {
      maxX = Math.max(maxX, item.x || 0, item.x2 || 0);
      maxY = Math.max(maxY, item.y || 0, item.y2 || 0);
      return;
    }
    maxX = Math.max(maxX, (item.x || 0) + 80);
    maxY = Math.max(maxY, (item.y || 0) + 40);
  });
  return { width: maxX, height: maxY };
}

function drawArrow(ctx, x1, y1, x2, y2) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  const headLength = 12;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLength * Math.cos(angle - Math.PI / 6), y2 - headLength * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headLength * Math.cos(angle + Math.PI / 6), y2 - headLength * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function drawImageAnnotations(ctx, imageRect, annotations = []) {
  if (!annotations.length) {
    return;
  }

  const bounds = getAnnotationBounds(annotations);
  const scaleX = imageRect.width / bounds.width;
  const scaleY = imageRect.height / bounds.height;

  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.lineWidth = 2.4;

  annotations.forEach((annotation) => {
    if (annotation.tool === "box") {
      const x = imageRect.x + (annotation.x || 0) * scaleX;
      const y = imageRect.y + (annotation.y || 0) * scaleY;
      const width = (annotation.width || 0) * scaleX;
      const height = (annotation.height || 0) * scaleY;
      drawRoundedRect(ctx, x, y, width, height, 10, "", "rgba(255, 255, 255, 0.88)");
    }

    if (annotation.tool === "arrow") {
      const x1 = imageRect.x + (annotation.x || 0) * scaleX;
      const y1 = imageRect.y + (annotation.y || 0) * scaleY;
      const x2 = imageRect.x + (annotation.x2 || 0) * scaleX;
      const y2 = imageRect.y + (annotation.y2 || 0) * scaleY;
      drawArrow(ctx, x1, y1, x2, y2);
    }

    if (annotation.tool === "text") {
      const x = imageRect.x + (annotation.x || 0) * scaleX;
      const y = imageRect.y + (annotation.y || 0) * scaleY;
      setTextStyle(ctx, 16, 600, TEXT_PRIMARY);
      ctx.fillText(annotation.text || "问题", x, y);
    }
  });

  ctx.restore();
}

async function drawIssuePhoto(ctx, canvas, group, x, y, width, height) {
  drawRoundedRect(ctx, x, y, width, height, 18, PANEL_BACKGROUND, STROKE_SOFT);

  const imageArea = {
    x: x + 18,
    y: y + 18,
    width: width - 36,
    height: height - 36
  };

  if (!group.reportImagePath) {
    setTextStyle(ctx, 32, 500, TEXT_SECONDARY, "center");
    ctx.fillText("照片", x + width / 2, y + height / 2 - 18);
    return;
  }

  try {
    const image = await loadCanvasImage(canvas, group.reportImagePath);
    const fit = computeImageFit(group.reportImageWidth, group.reportImageHeight, imageArea.width, imageArea.height);
    const drawX = imageArea.x + (imageArea.width - fit.width) / 2;
    const drawY = imageArea.y + (imageArea.height - fit.height) / 2;

    drawRoundedRect(ctx, imageArea.x, imageArea.y, imageArea.width, imageArea.height, 16, IMAGE_PLACEHOLDER, "");
    ctx.drawImage(image, drawX, drawY, fit.width, fit.height);
    if (group.reportImageSourceType !== "annotated") {
      drawImageAnnotations(ctx, {
        x: drawX,
        y: drawY,
        width: fit.width,
        height: fit.height
      }, group.annotations || []);
    }
  } catch (error) {
    setTextStyle(ctx, 24, 500, TEXT_SECONDARY, "center");
    ctx.fillText("图片加载失败", x + width / 2, y + height / 2 - 18);
  }
}

function drawIssueDetails(ctx, group, x, y, width, height) {
  drawRoundedRect(ctx, x, y, width, height, 18, "", STROKE_SOFT);

  const padX = 18;
  const lineY = y + 14;
  const fieldWidth = width - padX * 2;
  let currentY = lineY;

  group.items.forEach((item, index) => {
    drawRoundedRect(ctx, x + padX, currentY, 118, 30, 999, "", STROKE_SOFT);
    setTextStyle(ctx, 15, 600, TEXT_PRIMARY, "center");
    ctx.fillText(`问题 ${String(item.reportOrder + 1).padStart(2, "0")}`, x + padX + 59, currentY + 5);
    currentY += 40;

    const inlineFields = [
      { prefix: "问题等级：", value: item.severityText || "待定" },
      { prefix: "区域：", value: item.area || "待确认区域" },
      { prefix: "问题分类：", value: item.category || "待确认分类" }
    ];

    setTextStyle(ctx, 14, 500, TEXT_PRIMARY);
    inlineFields.forEach((field) => {
      const text = fitInlineText(ctx, field.prefix, field.value, fieldWidth);
      ctx.fillText(text, x + padX, currentY);
      currentY += 22;
    });

    const detailSections = [
      { prefix: "描述：", value: item.description || "待补充", maxLines: 2 },
      { prefix: "建议：", value: item.suggestion || "待补充", maxLines: 2 }
    ];

    detailSections.forEach((section) => {
      setTextStyle(ctx, 14, 500, TEXT_PRIMARY);
      ctx.fillText(section.prefix, x + padX, currentY);
      setTextStyle(ctx, 14, 400, TEXT_PRIMARY);
      const lines = limitLines(ctx, section.value, fieldWidth - 48, section.maxLines);
      drawLines(ctx, lines, x + padX + 48, currentY, 18);
      currentY += lines.length * 18 + 8;
    });

    if (item.visualEvidence) {
      setTextStyle(ctx, 13, 400, TEXT_SECONDARY);
      const evidenceText = fitInlineText(ctx, "依据：", item.visualEvidence, fieldWidth);
      ctx.fillText(evidenceText, x + padX, currentY);
      currentY += 20;
    }

    if (index !== group.items.length - 1) {
      ctx.strokeStyle = STROKE_SOFT;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + padX, currentY + 4);
      ctx.lineTo(x + width - padX, currentY + 4);
      ctx.stroke();
      currentY += 16;
    }
  });
}

function drawPageFrame(ctx) {
  drawRoundedRect(ctx, FRAME_X, FRAME_Y, FRAME_WIDTH, FRAME_HEIGHT, 0, "", STROKE_STRONG);
}

async function renderPdfPage(canvas, report, assets, pageData, pageIndex, totalPages) {
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  clearCanvas(ctx);

  const brandText = report.companyName || "LOGO";
  await drawBrandMark(ctx, canvas, assets.logoPath, brandText, CANVAS_WIDTH / 2, LOGO_TOP_Y, TOP_LOGO_MAX_WIDTH, TOP_LOGO_MAX_HEIGHT);
  await drawBrandMark(ctx, canvas, assets.logoPath, brandText, CANVAS_WIDTH / 2, LOGO_BOTTOM_Y, TOP_LOGO_MAX_WIDTH, TOP_LOGO_MAX_HEIGHT);
  await drawBrandMark(ctx, canvas, assets.logoPath, brandText, SIDE_LOGO_OFFSET_X, CANVAS_HEIGHT / 2 + 84, SIDE_LOGO_MAX_WIDTH, SIDE_LOGO_MAX_HEIGHT, -Math.PI / 2);
  await drawBrandMark(ctx, canvas, assets.logoPath, brandText, CANVAS_WIDTH - SIDE_LOGO_OFFSET_X, CANVAS_HEIGHT / 2 - 130, SIDE_LOGO_MAX_WIDTH, SIDE_LOGO_MAX_HEIGHT, Math.PI / 2);
  drawPageFrame(ctx);

  const innerX = FRAME_X + INNER_PADDING_X;
  const innerY = FRAME_Y + INNER_PADDING_Y;
  const innerWidth = FRAME_WIDTH - INNER_PADDING_X * 2;
  const dateParts = formatDateParts(report.inspectionDate);
  const title = `${report.projectName || report.title || "巡查报告"}巡查报告 / ${dateParts.year || "年"} / ${dateParts.month || "月"} / ${dateParts.day || "日"}`;
  setTextStyle(ctx, 36, 600, TEXT_PRIMARY, "left");
  const titleLines = limitLines(ctx, title, innerWidth, 2);
  drawLines(ctx, titleLines, innerX, innerY + 4, 42);

  const metaY = innerY + 24 + titleLines.length * 42;
  const metaCellWidth = Math.floor((innerWidth - 48) / 3);
  drawMetaCell(ctx, "项目", report.projectName || "-", innerX, metaY, metaCellWidth);
  drawMetaCell(ctx, "日期", `${dateParts.year}-${dateParts.month}-${dateParts.day}`, innerX + metaCellWidth + 24, metaY, metaCellWidth);
  drawMetaCell(
    ctx,
    "巡查人",
    report.inspectorName || "-",
    innerX + (metaCellWidth + 24) * 2,
    metaY,
    metaCellWidth,
    report.inspectorPhone ? `联系电话：${report.inspectorPhone}` : ""
  );

  const slotsTop = metaY + 84;
  const detailWidth = innerWidth - PHOTO_WIDTH - DETAIL_GAP;
  let currentY = slotsTop;

  for (let index = 0; index < pageData.groups.length; index += 1) {
    const group = pageData.groups[index];
    const layout = pageData.layouts[index];
    const slotHeight = layout.rowHeight;
    const slotY = currentY;

    ctx.strokeStyle = STROKE_SOFT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(innerX, slotY - 14);
    ctx.lineTo(innerX + innerWidth, slotY - 14);
    ctx.stroke();

    await drawIssuePhoto(ctx, canvas, group, innerX, slotY, PHOTO_WIDTH, slotHeight);
    drawIssueDetails(ctx, group, innerX + PHOTO_WIDTH + DETAIL_GAP, slotY, detailWidth, slotHeight);
    currentY += slotHeight + SLOT_GAP;
  }

  setTextStyle(ctx, 18, 500, TEXT_SECONDARY, "right");
  ctx.fillText(`${String(pageIndex + 1).padStart(2, "0")} / ${String(totalPages).padStart(2, "0")}`, FRAME_X + FRAME_WIDTH - 4, FRAME_Y + FRAME_HEIGHT + 20);

  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      fileType: "jpg",
      quality: 1,
      destWidth: CANVAS_WIDTH,
      destHeight: CANVAS_HEIGHT,
      success: resolve,
      fail: reject
    });
  });
}

function readFileBytes(filePath) {
  const fs = wx.getFileSystemManager();
  return new Promise((resolve, reject) => {
    fs.readFile({
      filePath,
      success: (result) => {
        resolve(new Uint8Array(result.data));
      },
      fail: reject
    });
  });
}

function buildImagePdfBuffer(pageImages) {
  const pageCount = pageImages.length;
  const maxObjectNumber = 2 + pageCount * 3;
  const offsets = new Array(maxObjectNumber + 1).fill(0);
  const chunks = [asciiBytes("%PDF-1.4\n")];
  let currentOffset = chunks[0].length;

  const writeObject = (num, dataChunks) => {
    offsets[num] = currentOffset;
    const objectBytes = concatBytes([
      asciiBytes(`${num} 0 obj\n`),
      ...dataChunks,
      asciiBytes("\nendobj\n")
    ]);
    chunks.push(objectBytes);
    currentOffset += objectBytes.length;
  };

  writeObject(1, [asciiBytes("<< /Type /Catalog /Pages 2 0 R >>")]);

  const kids = [];
  for (let index = 0; index < pageCount; index += 1) {
    kids.push(`${3 + index * 3} 0 R`);
  }
  writeObject(2, [asciiBytes(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>`)]);

  pageImages.forEach((page, index) => {
    const pageNum = 3 + index * 3;
    const contentNum = pageNum + 1;
    const imageNum = pageNum + 2;
    const contentStream = asciiBytes("q 595 0 0 842 0 0 cm /Im1 Do Q");

    writeObject(pageNum, [
      asciiBytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Resources << /XObject << /Im1 ${imageNum} 0 R >> >> /Contents ${contentNum} 0 R >>`)
    ]);
    writeObject(contentNum, [
      asciiBytes(`<< /Length ${contentStream.length} >>\nstream\n`),
      contentStream,
      asciiBytes("\nendstream")
    ]);
    writeObject(imageNum, [
      asciiBytes(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`),
      page.bytes,
      asciiBytes("\nendstream")
    ]);
  });

  const xrefOffset = currentOffset;
  const xrefLines = [asciiBytes(`xref\n0 ${maxObjectNumber + 1}\n`), asciiBytes("0000000000 65535 f \n")];
  for (let index = 1; index <= maxObjectNumber; index += 1) {
    xrefLines.push(asciiBytes(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`));
  }
  const trailer = asciiBytes(`trailer\n<< /Size ${maxObjectNumber + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  const xrefBytes = concatBytes([...xrefLines, trailer]);
  chunks.push(xrefBytes);

  return concatBytes(chunks).buffer;
}

async function createReportPdf(report, canvas) {
  if (!canvas) {
    throw new Error("报告渲染画布未准备好");
  }

  const fs = wx.getFileSystemManager();
  const assets = await buildItemAssets(report);
  const measureCtx = canvas.getContext("2d");
  const groups = buildImageGroups(assets.items);
  const pages = buildPages(groups, measureCtx);
  const pageImages = [];

  for (let index = 0; index < pages.length; index += 1) {
    const tempFile = await renderPdfPage(canvas, report, assets, pages[index], index, pages.length);
    const bytes = await readFileBytes(tempFile.tempFilePath);
    pageImages.push({
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      bytes
    });
  }

  const buffer = buildImagePdfBuffer(pageImages);
  const filePath = `${wx.env.USER_DATA_PATH}/inspection-report-${Date.now()}.pdf`;

  await new Promise((resolve, reject) => {
    fs.writeFile({
      filePath,
      data: buffer,
      encoding: "binary",
      success: resolve,
      fail: reject
    });
  });

  return filePath;
}

module.exports = {
  createReportPdf
};
