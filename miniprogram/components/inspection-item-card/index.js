const { mapSeverityText } = require("../../utils/format");
const { ISSUE_SEVERITY_OPTIONS, RESPONSIBLE_PARTY_OPTIONS } = require("../../constants/status");

function toChineseSectionNumber(value) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (value <= 10) {
    if (value === 10) {
      return "十";
    }
    return digits[value] || `${value}`;
  }
  if (value < 20) {
    return `十${digits[value - 10]}`;
  }
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${digits[tens]}十${ones ? digits[ones] : ""}`;
}

Component({
  properties: {
    item: {
      type: Object,
      value: {}
    },
    editable: {
      type: Boolean,
      value: false
    },
    index: {
      type: Number,
      value: 0
    },
    displayIndex: {
      type: Number,
      value: 0
    },
    titleText: {
      type: String,
      value: ""
    },
    hideTitle: {
      type: Boolean,
      value: false
    },
    showImages: {
      type: Boolean,
      value: true
    }
  },
  data: {
    severityOptions: ISSUE_SEVERITY_OPTIONS,
    responsiblePartyOptions: RESPONSIBLE_PARTY_OPTIONS,
    severityIndex: 0,
    responsiblePartyIndex: 3,
    resolvedTitle: "",
    showLeadingIndex: true
  },
  observers: {
    "item, index, displayIndex, titleText, hideTitle"(item) {
      const displayIndex = this.properties.displayIndex || (this.properties.index + 1);
      const resolvedTitle = this.properties.titleText || `问题${toChineseSectionNumber(displayIndex)}`;
      this.setData({
        severityText: mapSeverityText(item.severity),
        severityIndex: Math.max(0, ISSUE_SEVERITY_OPTIONS.findIndex((option) => option.value === item.severity)),
        responsiblePartyIndex: Math.max(0, RESPONSIBLE_PARTY_OPTIONS.findIndex((option) => option.value === item.responsibleParty)),
        resolvedTitle,
        showLeadingIndex: Boolean(this.properties.hideTitle)
      });
    }
  },
  methods: {
    handleChange(event) {
      const field = event.currentTarget.dataset.field;
      this.triggerEvent("change", {
        index: this.properties.index,
        field,
        value: event.detail.value
      });
    },
    handleSeverityChange(event) {
      const severityIndex = Number(event.detail.value || 0);
      const option = ISSUE_SEVERITY_OPTIONS[severityIndex] || ISSUE_SEVERITY_OPTIONS[0];
      this.triggerEvent("change", {
        index: this.properties.index,
        field: "severity",
        value: option.value
      });
    },
    handleResponsiblePartyChange(event) {
      const responsiblePartyIndex = Number(event.detail.value || 0);
      const option = RESPONSIBLE_PARTY_OPTIONS[responsiblePartyIndex] || RESPONSIBLE_PARTY_OPTIONS[RESPONSIBLE_PARTY_OPTIONS.length - 1];
      this.triggerEvent("change", {
        index: this.properties.index,
        field: "responsibleParty",
        value: option.value
      });
    }
  }
});
