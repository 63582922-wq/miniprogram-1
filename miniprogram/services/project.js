const { callCloud } = require("./cloud");

function listProjects(payload = {}) {
  return callCloud("project", {
    action: "list",
    payload
  });
}

function getProjectDetail(projectId) {
  return callCloud("project", {
    action: "detail",
    payload: { projectId }
  });
}

function saveProject(payload) {
  return callCloud("project", {
    action: payload.projectId ? "update" : "create",
    payload
  });
}

function deleteProject(projectId) {
  return callCloud("project", {
    action: "remove",
    payload: { projectId }
  });
}

function getProjectGallery(projectId) {
  return callCloud("project", {
    action: "gallery",
    payload: { projectId }
  });
}

module.exports = {
  listProjects,
  getProjectDetail,
  getProjectGallery,
  saveProject,
  deleteProject
};
