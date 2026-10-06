/**
 * The first-run account used to receive the role placeholder “巡查员”.
 * A role is not a traceable person's name, even if an older account saved it.
 */
function getInspectorName(user = {}) {
  const name = `${user.nickname || ""}`.trim();
  if (!name) return "";
  if (name === "巡查员") return "";
  return name;
}

/** Stable, human-readable report number shared by list and detail views. */
function buildReportNo(report = {}) {
  const raw = report.publishedAt || report.createdAt || report.generatedAt || report.inspectionDate;
  const date = new Date(Number(raw) || raw);
  const valid = !Number.isNaN(date.getTime());
  const ymd = valid
    ? `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`
    : "00000000";
  const tail = `${report._id || ""}`.slice(-4).toUpperCase();
  return `CB-${ymd}-${tail || "0000"}`;
}

module.exports = { getInspectorName, buildReportNo };
