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
      // recorderManager 是全局单例：必须在 detached 里解绑，
      // 否则组件每次进入都会再挂一个监听，同一次录音会被多次转写。
      this.boundOnStop = (result) => {
        const duration = Math.max(0, Date.now() - (this.data.recordStartedAt || 0));
        this.setData({
          recording: false,
          recordStartedAt: 0
        });

        if (!result || !result.tempFilePath) {
          wx.showToast({
            title: "没有录到声音，请重试",
            icon: "none"
          });
          return;
        }

        this.handleSpeechTranscription(result.tempFilePath, duration);
      };

      this.boundOnError = (error) => this.handleRecorderError(error);

      recorderManager.onStop(this.boundOnStop);
      recorderManager.onError(this.boundOnError);
    },
    detached() {
      if (this.boundOnStop && typeof recorderManager.offStop === "function") {
        recorderManager.offStop(this.boundOnStop);
      }
      if (this.boundOnError && typeof recorderManager.offError === "function") {
        recorderManager.offError(this.boundOnError);
      }
      this.boundOnStop = null;
      this.boundOnError = null;
    }
  },
  methods: {
    /**
     * 录音失败（最常见的是麦克风权限被拒）。
     *
     * recorderManager.start 没有 success/fail 回调，失败只能通过 onError 感知。
     * 原实现没有监听 onError，权限被拒后界面会一直停在「松开结束」，
     * 用户不知道发生了什么，也退不出来。
     */
    handleRecorderError(error) {
      console.error("[voice-recorder] recorder error", error);
      this.setData({
        recording: false,
        recordStartedAt: 0
      });

      const text = `${(error && error.errMsg) || (error && error.message) || ""}`;
      const denied = /auth deny|authorize|permission|拒绝|未授权/i.test(text);

      if (denied) {
        wx.showModal({
          title: "需要麦克风权限",
          content: "可以先在下方直接输入文字；也可在设置中允许麦克风后再录音。",
          confirmText: "去设置",
          cancelText: "知道了",
          success: (res) => {
            if (res.confirm && typeof wx.openSetting === "function") {
              wx.openSetting({});
            }
          }
        });
        return;
      }

      wx.showToast({
        title: "录音失败，请重试",
        icon: "none"
      });
    },
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
