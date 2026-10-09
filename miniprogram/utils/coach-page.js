const { isCoachStep, moveCoach, stopCoach, buildCoachTip, getNextCoachStep } = require("./coach");

/**
 * 页面接入高亮引导的最小接口。
 *
 * 此前每个页面都要自己写一遍「判断是不是当前步 → 量目标位置 → setData」，
 * 结果只有设置页写了一半（算了 coachTipVisible 却没有 UI 渲染它），
 * 其余页面干脆没接。这里把这段收敛成一次调用。
 *
 * 用法：
 *   const { coachData, coachMethods } = require("../../utils/coach-page");
 *   Page({ data: { ...coachData(), ... }, ...coachMethods("settingsSave", "#coach-save-target"), ... });
 *   然后在 onShow 里调用 this.syncCoach()。
 *
 * 关键设计：**推进不靠气泡上的按钮，靠用户真的做完了动作**。
 * 气泡上的按钮只有「跳过引导」和「知道了」两种——这一步的目标就是让用户去点
 * 那个高亮按钮，多给一个「下一步」只会把人从真实操作上引开。
 * 页面在动作成功后调用 advanceCoach()。
 */

/**
 * 量元素位置，带重试。
 *
 * 页面 onShow 时往往还在 loading，目标按钮尚未渲染，一次量不到就放弃会让
 * 引导永远不出现——设置页就是这么漏的：它的基础资料来自云端请求，
 * 比 2 秒的重试窗口慢，于是每次都放弃。默认等约 7 秒，够慢网络用。
 */
async function measureTargetWithRetry(selector, attempts = 24, interval = 300) {
  for (let i = 0; i < attempts; i++) {
    const rect = await measureTarget(selector);
    if (rect && rect.width && rect.height) {
      return rect;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return null;
}

/** 量一个页面元素的位置，供遮罩挖洞。取不到就返回 null。 */
function measureTarget(selector) {
  return new Promise((resolve) => {
    if (!selector || typeof wx.createSelectorQuery !== "function") {
      resolve(null);
      return;
    }
    wx.createSelectorQuery()
      .select(selector)
      .boundingClientRect((rect) => resolve(rect || null))
      .exec();
  });
}

/** 展开进 Page.data 的初始字段。 */
function coachData() {
  return {
    coachVisible: false,
    coachRect: null,
    coachTitle: "",
    coachDesc: "",
    coachStepText: ""
  };
}

/**
 * @param {string} stepKey        本页负责的引导步骤
 * @param {string} targetSelector 要高亮的元素选择器
 * @param {object} options
 *   - tip: { customTitle, customDesc, tailHint } 覆盖文案
 *   - ready(): 返回 false 表示目标此刻还不存在（例如还没有照片就没有「标注」）
 */
function coachMethods(stepKey, targetSelector, options = {}) {
  return {
    /** 在 onShow 里调用。 */
    async syncCoach() {
      if (!isCoachStep(stepKey) || (typeof options.ready === "function" && !options.ready.call(this))) {
        if (this.data.coachVisible) {
          this.setData({ coachVisible: false, coachRect: null });
        }
        return;
      }
      // 页面往往还在 loading，目标按钮要等数据回来才渲染，所以带重试地量
      const rect = await measureTargetWithRetry(targetSelector);
      if (!isCoachStep(stepKey)) {
        return;
      }
      const tip = buildCoachTip(stepKey, options.tip || {});
      const measurable = rect && rect.width && rect.height;
      if (!measurable && !options.pendingText) {
        // 目标不存在、也没准备「先做什么」的说明：宁可不显示，
        // 也不要弹一个指着空气的引导
        this.setData({ coachVisible: false, coachRect: null });
        return;
      }
      this.setData({
        coachVisible: true,
        coachRect: measurable ? rect : null,
        coachTitle: tip.title,
        coachDesc: tip.desc,
        coachStepText: tip.stepText,
        coachPendingText: measurable ? "" : (options.pendingText || "")
      });
    },
    /** 「知道了」：只收起气泡，步骤仍然激活——用户还没做那件事，下次回到本页还会提示。 */
    handleCoachNext() {
      this.setData({ coachVisible: false, coachRect: null, coachPendingText: "" });
    },
    /** 动作已真的完成，推进到下一步。 */
    advanceCoach() {
      const next = getNextCoachStep(stepKey);
      if (next) {
        moveCoach(next);
      } else {
        stopCoach();
      }
      this.setData({ coachVisible: false, coachRect: null, coachPendingText: "" });
    },
    /** 「跳过引导」：整段引导结束，不再打扰。 */
    handleCoachSkip() {
      stopCoach();
      this.setData({ coachVisible: false, coachRect: null });
    }
  };
}

/**
 * 同一页面上有多个引导步骤时用这个（现场记录页有 4 个：添加照片 → 标注 →
 * 按住说话 → 进入核对，它们依次激活，且后三个要等到有照片才存在）。
 *
 * @param {Array<{key:string, selector:string, ready?:Function}>} steps
 */
function coachMethodsMulti(steps, options = {}) {
  const base = {
    /** 当前页正在提示的那一步；advanceCoach 靠它决定推进到哪。 */
    activeCoachStep() {
      // 只用 isCoachStep 判定「这一步算不算数」。
      // ready() 判定的是「目标元素此刻在不在」，两者不能混：曾经把 ready
      // 并进来当过滤条件，导致还没有照片时没有任何步骤是激活的，
      // 连「先拍一张照片」的居中说明都不显示——流程走到一半就断了。
      return steps.find((item) => isCoachStep(item.key)) || null;
    },
    async syncCoach() {
      const active = this.activeCoachStep();
      if (!active) {
        if (this.data.coachVisible) {
          this.setData({ coachVisible: false, coachRect: null });
        }
        return;
      }
      // 目标此刻不存在就不去量，直接走下面的 pending 分支给一句「先做什么」。
      const targetExists = typeof active.ready !== "function" || active.ready.call(this);
      const rect = targetExists ? await measureTargetWithRetry(active.selector) : null;
      const confirmed = this.activeCoachStep();
      if (!confirmed || confirmed.key !== active.key) {
        return;
      }
      const tip = buildCoachTip(active.key, active.tip || options.tip || {});
      const measurable = rect && rect.width && rect.height;
      const pendingText = active.pendingText || options.pendingText || "";
      if (!measurable && !pendingText) {
        this.setData({ coachVisible: false, coachRect: null });
        return;
      }
      this.setData({
        coachVisible: true,
        coachRect: measurable ? rect : null,
        coachTitle: tip.title,
        coachDesc: tip.desc,
        coachStepText: tip.stepText,
        coachPendingText: measurable ? "" : pendingText
      });
    },
    handleCoachNext() {
      this.setData({ coachVisible: false, coachRect: null, coachPendingText: "" });
    },
    advanceCoach(fromStep) {
      const current = fromStep || (this.activeCoachStep() || {}).key;
      const next = current ? getNextCoachStep(current) : "";
      if (next) {
        moveCoach(next);
      } else {
        stopCoach();
      }
      this.setData({ coachVisible: false, coachRect: null });
    },
    handleCoachSkip() {
      stopCoach();
      this.setData({ coachVisible: false, coachRect: null });
    }
  };
  return base;
}

module.exports = { measureTarget, measureTargetWithRetry, coachData, coachMethods, coachMethodsMulti };
