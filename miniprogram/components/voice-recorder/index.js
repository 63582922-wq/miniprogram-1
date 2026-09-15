const recorderManager = wx.getRecorderManager();
const { transcribeVoiceFile, mergeSpeechText, formatSpeechError } = require("../../services/speech");

Component({
  properties: {
    value: {
      type: Object,
      value: {
        voiceText: "",
        voiceFilePath: ""
      }
    }
  },
  data: {
    recording: false,
    duration: 0,
    transcribing: false,
    recordingMode: "",
    recordStartedAt: 0
  },
  lifetimes: {
    attached() {
      recorderManager.onStop((result) => {
        const duration = Math.max(0, Date.now() - (this.data.recordStartedAt || 0));
        this.setData({
          recording: false,
          recordStartedAt: 0
        });

        this.handleSpeechTranscription(result.tempFilePath, duration);
      });
    }
  },
  methods: {
    emitChange(nextValue) {
      this.triggerEvent("change", nextValue);
    },
    handleTextInput(event) {
      this.emitChange({
        ...this.properties.value,
        voiceText: event.detail.value
      });
    },
    triggerRecordVibration() {
      if (typeof wx.vibrateShort !== "function") {
        return;
      }
      wx.vibrateShort({
        type: "medium"
      });
    },
    handleRecordLongPress() {
      if (this.data.recording || this.data.transcribing) {
        return;
      }
      recorderManager.start({
        format: "mp3",
        duration: 60000
      });
      this.setData({
        recording: true,
        recordStartedAt: Date.now()
      });
      this.triggerRecordVibration();
    },
    handleRecordTouchEnd() {
      if (!this.data.recording) {
        return;
      }
      this.triggerRecordVibration();
      recorderManager.stop();
    },
    async handleSpeechTranscription(tempFilePath, duration) {
      this.setData({
        transcribing: true
      });

      try {
        const result = await transcribeVoiceFile(tempFilePath, {
          duration,
          label: "memo"
        });
        this.emitChange({
          ...this.properties.value,
          voiceFilePath: tempFilePath,
          voiceText: mergeSpeechText(this.properties.value.voiceText, result.text, true)
        });
        wx.showToast({
          title: result.mode === "sentence" ? "转写完成" : "转写完成（慢路径）",
          icon: "success"
        });
      } catch (error) {
        this.emitChange({
          ...this.properties.value,
          voiceFilePath: tempFilePath
        });
        const speechError = formatSpeechError(error);
        wx.showToast({
          title: speechError.message,
          icon: "none",
          duration: 3000
        });
      } finally {
        this.setData({
          transcribing: false
        });
      }
    }
  }
});
