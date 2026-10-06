const { formatDate } = require("../../utils/format");

Component({
  properties: {
    project: {
      type: Object,
      value: {}
    }
  },
  methods: {
    handleTap() {
      this.triggerEvent("open", this.properties.project);
    },
    handleLongPress() {
      this.triggerEvent("longpress", this.properties.project);
    }
  },
  observers: {
    project(project) {
      const explicitTestMarker = `${project.address || ""} ${project.description || ""}`;
      const rawAddress = `${project.address || ""}`;
      // Keep the legacy QA fixture's English-only note understandable in the
      // Chinese UI without changing the stored project record or translating
      // user-authored addresses/descriptions.
      const displayAddress = /^isolated acceptance test$/i.test(rawAddress.trim())
        ? "隔离验收专用，不用于真实工程"
        : rawAddress;
      this.setData({
        dateText: formatDate(project.lastInspectionAt || project.updatedAt || Date.now()),
        displayAddress,
        clientNameText: project.clientName || "未填写",
        inspectionsCount: project.inspectionsCount || 0,
        issuesCount: project.issuesCount || 0,
        isTestProject: project.testOnly === true || project.isTestProject === true || /隔离验收专用|自动化验收专用|isolated acceptance test/i.test(explicitTestMarker)
      });
    }
  }
});
