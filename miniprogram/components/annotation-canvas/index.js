Component({
  properties: {
    imageUrl: {
      type: String,
      value: ""
    },
    value: {
      type: Array,
      value: []
    }
  },
  data: {
    tool: "move",
    history: [],
    stageRect: null,
    currentDrawing: null,
    renderItems: [],
    textEditorVisible: false,
    editingText: "",
    editingTextId: "",
    pendingTextPoint: null,
    draggingTextId: "",
    draggingTextOffset: null,
    preventNextTextTap: false,
    viewportScale: 1,
    viewportX: 0,
    viewportY: 0,
    viewportStyle: "transform: translate(0px, 0px) scale(1); transform-origin: 0 0;",
    gestureMode: "",
    panStartPoint: null,
    panStartViewport: null,
    pinchStartDistance: 0,
    pinchStartScale: 1
  },
  observers: {
    value() {
      this.syncRenderItems();
    }
  },
  lifetimes: {
    attached() {
      this.measureStage();
    }
  },
  methods: {
    measureStage() {
      const query = this.createSelectorQuery();
      query.select(".canvas-stage").boundingClientRect();
      query.exec((result) => {
        const rect = result && result[0];
        if (rect) {
          this.setData({
            stageRect: rect
          }, () => {
            this.syncRenderItems();
          });
          this.triggerEvent("stagechange", {
            width: rect.width,
            height: rect.height
          });
        }
      });
    },
    clampViewport(nextX, nextY, nextScale) {
      const rect = this.data.stageRect;
      if (!rect) {
        return {
          x: nextX,
          y: nextY
        };
      }
      const scaledWidth = rect.width * nextScale;
      const scaledHeight = rect.height * nextScale;
      const minX = Math.min(0, rect.width - scaledWidth);
      const minY = Math.min(0, rect.height - scaledHeight);
      return {
        x: Math.max(minX, Math.min(0, nextX)),
        y: Math.max(minY, Math.min(0, nextY))
      };
    },
    updateViewport(scale, x, y) {
      const nextScale = Math.max(1, Math.min(3, scale));
      const clamped = this.clampViewport(x, y, nextScale);
      this.setData({
        viewportScale: nextScale,
        viewportX: clamped.x,
        viewportY: clamped.y,
        viewportStyle: `transform: translate(${clamped.x}px, ${clamped.y}px) scale(${nextScale}); transform-origin: 0 0;`
      });
    },
    resetViewport() {
      this.setData({
        viewportScale: 1,
        viewportX: 0,
        viewportY: 0,
        viewportStyle: "transform: translate(0px, 0px) scale(1); transform-origin: 0 0;",
        gestureMode: "",
        panStartPoint: null,
        panStartViewport: null,
        pinchStartDistance: 0,
        pinchStartScale: 1
      });
    },
    getTouchDistance(touches = []) {
      if (!touches || touches.length < 2) {
        return 0;
      }
      const [first, second] = touches;
      const dx = second.pageX - first.pageX;
      const dy = second.pageY - first.pageY;
      return Math.sqrt(dx * dx + dy * dy);
    },
    setTool(event) {
      this.setData({
        tool: event.currentTarget.dataset.tool
      });
    },
    getLocalPoint(event) {
      if (!this.properties.imageUrl) {
        return null;
      }

      if (!this.data.stageRect) {
        this.measureStage();
      }

      const touch = (event.changedTouches && event.changedTouches[0]) || null;
      const rect = this.data.stageRect;
      const pageX = touch ? touch.pageX : event.detail.x;
      const pageY = touch ? touch.pageY : event.detail.y;
      const localX = rect ? (pageX - rect.left - this.data.viewportX) / this.data.viewportScale : pageX;
      const localY = rect ? (pageY - rect.top - this.data.viewportY) / this.data.viewportScale : pageY;
      return {
        x: rect ? Math.max(0, Math.min(rect.width, localX)) : localX,
        y: rect ? Math.max(0, Math.min(rect.height, localY)) : localY
      };
    },
    handleStageTouchStart(event) {
      const touches = event.touches || [];
      if (touches.length >= 2) {
        this.setData({
          gestureMode: "pinch",
          pinchStartDistance: this.getTouchDistance(touches),
          pinchStartScale: this.data.viewportScale,
          currentDrawing: null
        }, () => {
          this.syncRenderItems();
        });
        return;
      }

      if (this.data.tool === "move") {
        const touch = (event.changedTouches && event.changedTouches[0]) || null;
        if (!touch) {
          return;
        }
        this.setData({
          gestureMode: "pan",
          panStartPoint: {
            x: touch.pageX,
            y: touch.pageY
          },
          panStartViewport: {
            x: this.data.viewportX,
            y: this.data.viewportY
          }
        });
        return;
      }

      this.handleDrawStart(event);
    },
    handleStageTouchMove(event) {
      const touches = event.touches || [];
      if (touches.length >= 2 || this.data.gestureMode === "pinch") {
        const distance = this.getTouchDistance(touches);
        if (!distance || !this.data.pinchStartDistance) {
          return;
        }
        const nextScale = this.data.pinchStartScale * (distance / this.data.pinchStartDistance);
        this.updateViewport(nextScale, this.data.viewportX, this.data.viewportY);
        return;
      }

      if (this.data.gestureMode === "pan" && this.data.panStartPoint && this.data.panStartViewport) {
        const touch = (event.changedTouches && event.changedTouches[0]) || null;
        if (!touch) {
          return;
        }
        const nextX = this.data.panStartViewport.x + (touch.pageX - this.data.panStartPoint.x);
        const nextY = this.data.panStartViewport.y + (touch.pageY - this.data.panStartPoint.y);
        this.updateViewport(this.data.viewportScale, nextX, nextY);
        return;
      }

      this.handleDrawMove(event);
    },
    handleStageTouchEnd() {
      if (this.data.gestureMode === "pinch" || this.data.gestureMode === "pan") {
        this.setData({
          gestureMode: "",
          panStartPoint: null,
          panStartViewport: null,
          pinchStartDistance: 0,
          pinchStartScale: this.data.viewportScale
        });
        return;
      }
      this.handleDrawEnd();
    },
    handleDrawStart(event) {
      const point = this.getLocalPoint(event);
      if (!point) {
        return;
      }

      if (this.data.tool === "text") {
        this.openTextEditor({
          point,
          text: "",
          id: ""
        });
        return;
      }

      this.setData({
        currentDrawing: {
          tool: this.data.tool,
          startX: point.x,
          startY: point.y,
          endX: point.x,
          endY: point.y
        }
      }, () => {
        this.syncRenderItems();
      });
    },
    handleDrawMove(event) {
      if (!this.data.currentDrawing) {
        return;
      }

      const point = this.getLocalPoint(event);
      if (!point) {
        return;
      }

      this.setData({
        currentDrawing: {
          ...this.data.currentDrawing,
          endX: point.x,
          endY: point.y
        }
      }, () => {
        this.syncRenderItems();
      });
    },
    handleDrawEnd() {
      const drawing = this.data.currentDrawing;
      if (!drawing) {
        return;
      }

      const annotation = this.buildAnnotationFromDrawing(drawing);
      this.setData({
        currentDrawing: null
      }, () => {
        this.syncRenderItems();
      });

      if (!annotation) {
        return;
      }

      this.setData({
        history: []
      });
      this.triggerEvent("change", (this.properties.value || []).concat(annotation));
    },
    handleImageReady() {
      this.measureStage();
      this.resetViewport();
    },
    openTextEditor({ point = null, text = "", id = "" }) {
      this.setData({
        textEditorVisible: true,
        editingText: text,
        editingTextId: id,
        pendingTextPoint: point
      });
    },
    handleEditText(event) {
      const { id, tool } = event.currentTarget.dataset;
      if (tool !== "text") {
        return;
      }
      if (this.data.preventNextTextTap) {
        this.setData({
          preventNextTextTap: false
        });
        return;
      }
      const target = (this.properties.value || []).find((item) => item.id === id);
      if (!target || target.tool !== "text") {
        return;
      }

      this.openTextEditor({
        text: target.text || "",
        id: target.id
      });
    },
    handleTextInput(event) {
      this.setData({
        editingText: event.detail.value
      });
    },
    handleCancelTextEdit() {
      this.setData({
        textEditorVisible: false,
        editingText: "",
        editingTextId: "",
        pendingTextPoint: null
      });
    },
    handleMarkTouchStart(event) {
      const { id, tool } = event.currentTarget.dataset;
      if (tool !== "text") {
        return;
      }
      const point = this.getLocalPoint(event);
      const target = (this.properties.value || []).find((item) => item.id === id);
      if (!point || !target) {
        return;
      }

      this.setData({
        draggingTextId: id,
        draggingTextOffset: {
          x: point.x - target.x,
          y: point.y - target.y
        },
        preventNextTextTap: false
      });
    },
    handleMarkTouchMove(event) {
      const { id, tool } = event.currentTarget.dataset;
      if (tool !== "text" || !this.data.draggingTextId || this.data.draggingTextId !== id) {
        return;
      }
      const point = this.getLocalPoint(event);
      const offset = this.data.draggingTextOffset;
      if (!point || !offset) {
        return;
      }

      const nextValue = (this.properties.value || []).map((item) => {
        if (item.id !== id) {
          return item;
        }
        return {
          ...item,
          x: point.x - offset.x,
          y: point.y - offset.y
        };
      });

      this.triggerEvent("change", nextValue);
      this.setData({
        preventNextTextTap: true
      });
    },
    handleMarkTouchEnd() {
      if (!this.data.draggingTextId) {
        return;
      }
      this.setData({
        draggingTextId: "",
        draggingTextOffset: null
      });
      if (this.data.preventNextTextTap) {
        setTimeout(() => {
          this.setData({
            preventNextTextTap: false
          });
        }, 80);
      }
    },
    handleConfirmTextEdit() {
      const text = (this.data.editingText || "").trim();
      if (!text) {
        wx.showToast({
          title: "请输入文字内容",
          icon: "none"
        });
        return;
      }

      const currentValue = (this.properties.value || []).slice();
      let nextValue = currentValue;

      if (this.data.editingTextId) {
        nextValue = currentValue.map((item) => item.id === this.data.editingTextId
          ? {
              ...item,
              text
            }
          : item);
      } else if (this.data.pendingTextPoint) {
        nextValue = currentValue.concat({
          id: `${Date.now()}-${Math.random()}`,
          tool: "text",
          x: this.data.pendingTextPoint.x,
          y: this.data.pendingTextPoint.y,
          text
        });
      }

      this.setData({
        history: [],
        textEditorVisible: false,
        editingText: "",
        editingTextId: "",
        pendingTextPoint: null
      });
      this.triggerEvent("change", nextValue);
    },
    buildAnnotationFromDrawing(drawing) {
      const dx = drawing.endX - drawing.startX;
      const dy = drawing.endY - drawing.startY;

      if (drawing.tool === "box") {
        const width = Math.abs(dx);
        const height = Math.abs(dy);
        if (width < 12 || height < 12) {
          return null;
        }

        return {
          id: `${Date.now()}-${Math.random()}`,
          tool: "box",
          x: Math.min(drawing.startX, drawing.endX),
          y: Math.min(drawing.startY, drawing.endY),
          width,
          height
        };
      }

      if (drawing.tool === "arrow") {
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length < 16) {
          return null;
        }

        return {
          id: `${Date.now()}-${Math.random()}`,
          tool: "arrow",
          x: drawing.startX,
          y: drawing.startY,
          x2: drawing.endX,
          y2: drawing.endY
        };
      }

      return null;
    },
    syncRenderItems() {
      const items = (this.properties.value || []).map((item) => this.toRenderItem(item, false));
      if (this.data.currentDrawing) {
        const preview = this.buildAnnotationFromDrawing(this.data.currentDrawing);
        if (preview) {
          items.push(this.toRenderItem(preview, true));
        }
      }

      this.setData({
        renderItems: items
      });
    },
    toRenderItem(item, preview) {
      if (item.tool === "box") {
        return {
          id: item.id,
          rawId: item.id,
          tool: item.tool,
          preview,
          style: `left:${item.x}px;top:${item.y}px;width:${item.width}px;height:${item.height}px;`
        };
      }

      if (item.tool === "arrow") {
        const dx = (item.x2 || item.x) - item.x;
        const dy = (item.y2 || item.y) - item.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        return {
          id: item.id,
          rawId: item.id,
          tool: item.tool,
          preview,
          style: `left:${item.x}px;top:${item.y}px;width:${length}px;transform:rotate(${angle}deg);`
        };
      }

      return {
        id: item.id,
        rawId: item.id,
        tool: item.tool,
        preview,
        text: item.text || "问题",
        style: `left:${item.x}px;top:${item.y}px;`,
        rawId: item.id
      };
    },
    undo() {
      const currentValue = this.properties.value || [];
      if (!currentValue.length) {
        return;
      }

      const last = currentValue[currentValue.length - 1];
      this.setData({
        history: this.data.history.concat(last)
      });
      this.triggerEvent("change", currentValue.slice(0, -1));
    },
    redo() {
      const history = this.data.history || [];
      if (!history.length) {
        return;
      }

      const last = history[history.length - 1];
      this.setData({
        history: history.slice(0, -1)
      });
      this.triggerEvent("change", (this.properties.value || []).concat(last));
    },
    noop() {
    }
  }
});
