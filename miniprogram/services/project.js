const { callCloud } = require("./cloud");

async function listProjects(payload = {}) {
  if(payload.page)return callCloud("project",{action:"list",payload});
  // Dropdowns and historical consumers need the entire catalogue, not the default page.
  const list=[];let page=1,result;
  do{result=await callCloud("project",{action:"list",payload:{...payload,page,pageSize:50}});list.push(...(result.list||[]));page++;}
  while(result.hasMore || (result.total && list.length<result.total));
  return {list,total:list.length};
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
