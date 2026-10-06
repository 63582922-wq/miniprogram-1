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
    metadataExpanded: false,
    severityOptions: ISSUE_SEVERITY_OPTIONS,
    responsiblePartyOptions: RESPONSIBLE_PARTY_OPTIONS,
    severityIndex: 0,
    responsiblePartyIndex: 3,
    resolvedTitle: "",
    showLeadingIndex: true,
    sourceQuoteExpanded: false,
    showSourceQuote: false
  },
  observers: {
    "item, index, displayIndex, titleText, hideTitle, editable"(item) {
      if(item.id!==this.editingItemId){this.editingItemId=item.id;this.setData({editing:this.properties.editable&&!String(item.description||'').trim(),metadataExpanded:false});}
      const displayIndex = this.properties.displayIndex || (this.properties.index + 1);
      const resolvedTitle = this.properties.titleText || `问题${toChineseSectionNumber(displayIndex)}`;
      const displayImages = Array.isArray(item.annotatedImages) && item.annotatedImages.length
        ? item.annotatedImages
        : (Array.isArray(item.images) ? item.images : []);
      const sourceQuote = String(item.sourceQuote || '').trim();
      const description = String(item.description || '').trim();
      this.setData({
        severityText: mapSeverityText(item.severity),
        severityIndex: Math.max(0, ISSUE_SEVERITY_OPTIONS.findIndex((option) => option.value === item.severity)),
        responsiblePartyIndex: Math.max(0, RESPONSIBLE_PARTY_OPTIONS.findIndex((option) => option.value === item.responsibleParty)),
        resolvedTitle,
        displayImages,
        showLeadingIndex: Boolean(this.properties.hideTitle),
        sourceQuoteExpanded: false,
        showSourceQuote: Boolean(this.properties.editable && item.textOrganized && sourceQuote && sourceQuote !== description)
      });
    }
  },
  methods: {
    toggleEditing(){this.setData({editing:!this.data.editing});},
    toggleMetadata(){this.setData({metadataExpanded:!this.data.metadataExpanded});},
    toggleSourceQuote(){this.setData({sourceQuoteExpanded:!this.data.sourceQuoteExpanded});},
    deleteItem(){this.triggerEvent('delete',{index:this.properties.index});},
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
