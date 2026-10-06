Component({
  data:{hiddenByOverlay:false,selected:"",list:[
    {pagePath:"pages/project/list/index",text:"项目",iconName:"project",activeIconName:"project-active",selected:false,iconSrc:"/images/icons/icon-tab-project.png"},
    {pagePath:"pages/report/list/index",text:"报告",iconName:"report",activeIconName:"report-active",selected:false,iconSrc:"/images/icons/icon-tab-report.png"},
    {pagePath:"pages/profile/index",text:"我的",iconName:"profile",activeIconName:"profile-active",selected:false,iconSrc:"/images/icons/icon-tab-profile.png"}
  ]},
  lifetimes:{attached(){this.syncSelection();},ready(){this.syncSelection();}},
  pageLifetimes:{show(){this.syncSelection();}},
  methods:{
    applySelection(route){
      route=String(route||"").replace(/^\//, "");
      const list=this.data.list.map(item=>{
        const selected=item.pagePath===route;
        return Object.assign({},item,{selected,iconSrc:"/images/icons/icon-tab-"+(selected?item.activeIconName:item.iconName)+".png"});
      });
      this.setData({selected:route,list});
    },
    syncSelection(){
      const pages=getCurrentPages();
      const route=pages.length?String(pages[pages.length-1].route||"").replace(/^\//, ""):"";
      this.applySelection(route);
    },
    switchTab(e){const path=e.currentTarget.dataset.path;if(!path||path===this.data.selected)return;
      wx.switchTab({url:"/"+path,success:()=>this.applySelection(path)});}
  }
});
