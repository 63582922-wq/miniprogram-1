/**
 * 新手引导的高亮遮罩。
 *
 * 做法是「四块遮罩围出一个洞」，而不是用 box-shadow 或 pointer-events：
 * - 洞的位置不渲染任何元素，所以点击会**直接落到被高亮的按钮上**，
 *   用户是真的在点那个按钮，而不是点一个代理层；
 * - 洞以外的四块遮罩盖住页面，避免用户点到别处；
 * - 容器本身是 0×0 的定位锚点，不参与命中测试。
 *
 * 用 box-shadow 铺满屏幕也能做出「挖洞」的观感，但那样洞上会有一层元素，
 * 要么依赖 pointer-events（小程序支持不稳），要么用户点不动目标按钮。
 */

const GAP = 6;          // 高亮框比目标大一圈，让按钮看起来被"框住"（留出呼吸）
const TIP_MARGIN = 12;  // 提示气泡与高亮框的距离

Component({
  properties: {
    visible: { type: Boolean, value: false },
    rect: { type: Object, value: null },   // 目标元素的位置，由页面用 boundingClientRect 取
    title: { type: String, value: "" },
    desc: { type: String, value: "" },
    stepText: { type: String, value: "" },
    /** 目标还没出现时补一句「先做什么」，例如还没有照片就没有「标注」可指。 */
    pendingText: { type: String, value: "" },
    showSkip: { type: Boolean, value: true }
  },

  data: {
    hole: null,
    masks: null,
    tipStyle: "",
    placeBelow: true
  },

  observers: {
    "visible, rect": function (visible, rect) {
      if (!visible) {
        this.setData({ hole: null, masks: null, tipStyle: "" });
        return;
      }
      // 目标还没出现（例如还没有照片，就没有「标注」可指）时不能什么都不显示——
      // 那样用户会觉得引导走到一半断了。改为整屏压暗 + 居中气泡说明下一步做什么。
      this.layout(rect || null);
    }
  },

  methods: {
    layout(rect) {
      const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {};
      const viewportWidth = Number(info.windowWidth) || 375;
      const viewportHeight = Number(info.windowHeight) || 667;

      if (!rect) {
        // pending 模式：不画洞也不画框，WXML 用一整块遮罩盖住全屏
        this.setData({ hole: null, masks: null, tipStyle: "" });
        return;
      }

      const left = Math.max(0, Number(rect.left) - GAP);
      const top = Math.max(0, Number(rect.top) - GAP);
      const width = Math.max(0, Number(rect.width) + GAP * 2);
      const height = Math.max(0, Number(rect.height) + GAP * 2);
      const right = Math.min(viewportWidth, left + width);
      const bottom = Math.min(viewportHeight, top + height);

      // 目标在屏幕下半部分时，气泡放到上方，避免被键盘或底部栏顶住
      const placeBelow = bottom < viewportHeight * 0.62;

      this.setData({
        hole: { left, top, width: right - left, height: bottom - top },
        masks: {
          top: { left: 0, top: 0, width: viewportWidth, height: top },
          left: { left: 0, top, width: left, height: bottom - top },
          right: { left: right, top, width: Math.max(0, viewportWidth - right), height: bottom - top },
          bottom: { left: 0, top: bottom, width: viewportWidth, height: Math.max(0, viewportHeight - bottom) }
        },
        placeBelow,
        tipStyle: placeBelow
          ? `left:${TIP_MARGIN}px;right:${TIP_MARGIN}px;top:${Math.min(bottom + TIP_MARGIN, viewportHeight - 24)}px`
          : `left:${TIP_MARGIN}px;right:${TIP_MARGIN}px;bottom:${Math.min(viewportHeight - top + TIP_MARGIN, viewportHeight - 24)}px`
      });

      // 目标可能被滚动条挡着，主动带进视野，否则高亮框是空的
      if (typeof wx.pageScrollTo === "function" && (rect.top < 0 || rect.bottom > viewportHeight)) {
        wx.pageScrollTo({ scrollTop: Math.max(0, rect.top - viewportHeight / 3), duration: 200 });
      }
    },
    handleNext() { this.triggerEvent("next"); },
    handleSkip() { this.triggerEvent("skip"); },
    noop() {}
  }
});
