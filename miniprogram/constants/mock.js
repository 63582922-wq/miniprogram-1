const inspectionIssues = [
  {
    area: "客厅吊顶",
    category: "木作",
    severity: "major",
    responsibleParty: "constructor",
    description: "吊顶转角处收口不顺直，存在明显高低差。",
    suggestion: "重新校正龙骨并补做找平，复检收口平整度。"
  },
  {
    area: "卫生间墙砖",
    category: "泥工",
    severity: "critical",
    responsibleParty: "constructor",
    description: "墙砖十字缝不均匀，局部空鼓风险较高。",
    suggestion: "拆除空鼓区域后重新铺贴，统一缝宽并复核垂直度。"
  }
];

module.exports = {
  inspectionIssues
};
