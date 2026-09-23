function syncTabBar(page, route) {
  if (!page || typeof page.getTabBar !== "function") return false;
  const tabBar = page.getTabBar();
  const selected = route || page.route || "";
  if (!tabBar || typeof tabBar.setData !== "function" || !selected) return false;
  if (!tabBar.data || tabBar.data.selected !== selected) {
    tabBar.setData({ selected });
  }
  return true;
}

module.exports = { syncTabBar };
