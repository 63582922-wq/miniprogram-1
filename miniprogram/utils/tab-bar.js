function syncTabBar(page, route) {
  if (!page || typeof page.getTabBar !== "function") return false;
  const tabBar = page.getTabBar();
  const selected = String(route || page.route || "").replace(/^\//, "");
  if (!tabBar || typeof tabBar.setData !== "function" || !selected) return false;
  const list = (tabBar.data && Array.isArray(tabBar.data.list) ? tabBar.data.list : []).map(item => {
    const isSelected = item.pagePath === selected;
    return Object.assign({}, item, {
      selected: isSelected,
      iconSrc: "/images/icons/icon-tab-" + (isSelected ? item.activeIconName : item.iconName) + ".png"
    });
  });
  if (!tabBar.data || tabBar.data.selected !== selected || list.some((item, index) => {
    const current = tabBar.data.list && tabBar.data.list[index];
    return !current || current.selected !== item.selected || current.iconSrc !== item.iconSrc;
  })) tabBar.setData({ selected, list });
  return true;
}

module.exports = { syncTabBar };
