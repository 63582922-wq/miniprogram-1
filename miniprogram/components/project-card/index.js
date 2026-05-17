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
    }
  },
  observers: {
    project(project) {
      this.setData({
        dateText: formatDate(project.lastInspectionAt || project.updatedAt || Date.now()),
        clientNameText: project.clientName || "未填写",
        inspectionsCount: project.inspectionsCount || 0,
        issuesCount: project.issuesCount || 0
      });
    }
  }
});
