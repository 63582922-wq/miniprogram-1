Component({
  properties: {
    title: {
      type: String,
      value: "暂无数据"
    },
    description: {
      type: String,
      value: ""
    },
    /**
     * 可选的主操作文案。
     *
     * 空态只说「暂无项目」是死路 —— 用户知道这里没东西，
     * 但不知道该做什么。给出动作按钮，冷启动才有下一步。
     */
    actionText: {
      type: String,
      value: ""
    }
  },
  methods: {
    handleAction() {
      this.triggerEvent("action");
    }
  }
});
