const { mapSeverityText, toChineseSectionNumber } = require("../../utils/format");
const { ISSUE_SEVERITY_OPTIONS, RESPONSIBLE_PARTY_OPTIONS } = require("../../constants/status");

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
    editing: false,
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
    toggleEditing(){this.setData({editing:!this.data.editing});},
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
