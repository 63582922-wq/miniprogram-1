const { isCoachStep, moveCoach, stopCoach, buildCoachTip, getNextCoachStep, getCoachState } = require("./coach");

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

/**
 * 等目标出现：既等元素渲染出来，也等「这一步的前提」成立。
 *
 * 以前只重试量元素，ready() 却只在开头判一次——草稿还没恢复完就判成
 * 「还没有照片」，于是明明有照片却提示「先拍一张照片」。
 * 前提和元素都要一起等。
 */
async function waitForTarget(selector, isReady, attempts = 24, interval = 300) {
  for (let i = 0; i < attempts; i++) {
    if (typeof isReady !== "function" || isReady()) {
      const rect = await measureTarget(selector);
      if (rect && rect.width && rect.height) {
        return rect;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return null;
}

/**
 * 页面还活着吗。
 *
 * 引导是「等目标出现」的：最长会等约 7 秒。用户完全可能在这期间就返回了，
 * 那时 setData 会打到一个已经卸载的页面上——轻则控制台报错，
 * 重则把状态写进一个不该再被触碰的实例。项目里其它异步都用
 * generation 计数防这类竞态，引导这里用「还在不在页面栈里」判断即可。
 */
function isPageAlive(page) {
  try {
    if (!page || typeof getCurrentPages !== "function") return false;
    return getCurrentPages().indexOf(page) >= 0;
  } catch (_error) {
    return false;
  }
}

/** 只在页面还活着时写数据。返回是否真的写了。 */
function setCoachData(page, data) {
  if (!isPageAlive(page)) return false;
  page.setData(data);
  return true;
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
          setCoachData(this, { coachVisible: false, coachRect: null });
        }
        return;
      }
      // 页面往往还在 loading，目标按钮要等数据回来才渲染，所以带重试地量
      const rect = await waitForTarget(targetSelector, options.ready ? () => options.ready.call(this) : null);
      if (!isCoachStep(stepKey)) {
        return;
      }
      const tip = buildCoachTip(stepKey, options.tip || {});
      const measurable = rect && rect.width && rect.height;
      if (!measurable && !options.pendingText) {
        // 目标不存在、也没准备「先做什么」的说明：宁可不显示，
        // 也不要弹一个指着空气的引导
        setCoachData(this, { coachVisible: false, coachRect: null });
        return;
      }
      setCoachData(this, {
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
      setCoachData(this, { coachVisible: false, coachRect: null, coachPendingText: "" });
    },
    /**
     * 动作已真的完成，推进到下一步。
     *
     * 两个前提缺一不可，否则「引导只在首次出现」这条就守不住：
     *  1. 引导必须还在进行中。走完之后用户照常建第二份、第三份报告，
     *     页面还是会调到这里；不看 active 就会把引导重新激活。
     *  2. 当前步骤必须对得上。页面传进来的 / 捕获的 stepKey 是「刚做完哪个
     *     动作」，不是权威状态；用户跳着操作时按它推进会跳步。
     */
    advanceCoach(fromStep) {
      const state = getCoachState();
      if (!state.active) return;
      const current = state.step;
      const key = fromStep || stepKey;
      if (current && key && key !== current) return;
      const next = getNextCoachStep(current || key);
      if (next) {
        moveCoach(next);
      } else {
        stopCoach();
      }
      setCoachData(this, { coachVisible: false, coachRect: null, coachPendingText: "" });
    },
    /** 「跳过引导」：整段引导结束，不再打扰。 */
    handleCoachSkip() {
      stopCoach();
      setCoachData(this, { coachVisible: false, coachRect: null });
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
          setCoachData(this, { coachVisible: false, coachRect: null });
        }
        return;
      }
      // 前提（例如「已经有照片了」）与元素一起等：草稿恢复是异步的，
      // 只在开头判一次会把「还没恢复完」误判成「还没有照片」。
      const rect = await waitForTarget(active.selector,
        typeof active.ready === "function" ? () => active.ready.call(this) : null);
      const confirmed = this.activeCoachStep();
      if (!confirmed || confirmed.key !== active.key) {
        return;
      }
      const tip = buildCoachTip(active.key, active.tip || options.tip || {});
      const measurable = rect && rect.width && rect.height;
      const pendingText = active.pendingText || options.pendingText || "";
      if (!measurable && !pendingText) {
        setCoachData(this, { coachVisible: false, coachRect: null });
        return;
      }
      setCoachData(this, {
        coachVisible: true,
        coachRect: measurable ? rect : null,
        coachTitle: tip.title,
        coachDesc: tip.desc,
        coachStepText: tip.stepText,
        coachPendingText: measurable ? "" : pendingText
      });
    },
    handleCoachNext() {
      setCoachData(this, { coachVisible: false, coachRect: null, coachPendingText: "" });
    },
    advanceCoach(fromStep) {
      // 引导走完一遍就结束了。此后用户正常用（建第二个、第三个报告）时，
      // 页面照样会在动作成功后调 advanceCoach——原来这里不看引导是否还在进行，
      // 只要 getNextCoachStep 还能返回下一步就把引导重新激活，
      // 于是每建一次新报告，走过的引导又冒出来一次。
      const state = getCoachState();
      if (!state.active) return;
      // 页面传进来的 fromStep 是「刚做完哪个动作」，不是权威状态。
      // 只有当前确实停在这一步才推进；对不上就不动，避免跳步或重复推进。
      const current = state.step;
      if (fromStep && fromStep !== current) return;
      const next = current ? getNextCoachStep(current) : "";
      if (next) {
        moveCoach(next);
      } else {
        stopCoach();
      }
      setCoachData(this, { coachVisible: false, coachRect: null });
    },
    handleCoachSkip() {
      stopCoach();
      setCoachData(this, { coachVisible: false, coachRect: null });
    }
  };
  return base;
}

module.exports = { isPageAlive, setCoachData, measureTarget, measureTargetWithRetry, waitForTarget, coachData, coachMethods, coachMethodsMulti };
