Component({
  data:{selected:"",list:[
    {pagePath:"pages/project/list/index",text:"项目",iconName:"project",activeIconName:"project-active"},
    {pagePath:"pages/report/list/index",text:"报告",iconName:"report",activeIconName:"report-active"},
    {pagePath:"pages/profile/index",text:"我的",iconName:"profile",activeIconName:"profile-active"}
  ]},
  lifetimes:{attached(){this.syncSelection();},ready(){this.syncSelection();}},
  pageLifetimes:{show(){this.syncSelection();}},
  methods:{
    syncSelection(){const pages=getCurrentPages();this.setData({selected:pages.length?pages[pages.length-1].route:""});},
    switchTab(e){const path=e.currentTarget.dataset.path;if(!path||path===this.data.selected)return;
      wx.switchTab({url:"/"+path,success:()=>this.setData({selected:path})});}
  }
});
