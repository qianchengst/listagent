(() => {
  const api = window.listagent;
  const el = (selector) => document.querySelector(selector);
  const labels = {
    idle: '等待中',
    captured: '已截图',
    baseline: '已建立基线',
    inspected: '识图完成',
    skipped: '已跳过',
    replied: '已回复',
    error: '错误'
  };

  function render(event = {}) {
    const state = event.state || 'idle';
    const sender = event.sender || 'unknown';
    const image = el('#debug-screenshot');
    const empty = el('#debug-empty');
    if (event.imageDataUrl) {
      if (image.src !== event.imageDataUrl) image.src = event.imageDataUrl;
      image.hidden = false;
      empty.hidden = true;
    }
    el('#debug-state').textContent = labels[state] || state;
    el('#debug-message').textContent = event.message || '（无状态信息）';
    el('#debug-capture-method').textContent = event.captureMethod || '（未知）';
    el('#debug-capture-size').textContent = event.captureWidth && event.captureHeight ? `${event.captureWidth} × ${event.captureHeight}` : '（未知）';
    el('#debug-sender').textContent = sender;
    el('#debug-sender').className = `sender-badge sender-${sender}`;
    el('#debug-sender-text').textContent = sender;
    el('#debug-sender-reason').textContent = event.senderReason || '（未知）';
    el('#debug-recognized-text').textContent = event.recognizedText || '（空）';
    el('#debug-raw').textContent = event.raw || '（空）';
    if (event.timestamp) {
      const date = new Date(event.timestamp);
      el('#debug-time').textContent = Number.isNaN(date.valueOf()) ? event.timestamp : date.toLocaleString();
    }
  }

  api.getWechatDebugState().then(render).catch((error) => {
    el('#debug-message').textContent = `无法读取调试状态：${error.message}`;
  });
  api.onWechatDebugEvent(render);
  el('#debug-capture').addEventListener('click', async () => {
    const button = el('#debug-capture');
    button.disabled = true;
    el('#debug-action-status').textContent = '正在直接截取微信窗口原始 PNG；识图为可选步骤…';
    try {
      await api.captureWechatDebug();
      el('#debug-action-status').textContent = '截图完成；没有发送任何微信消息。若视觉模型可用，识别结果也已更新。';
    } catch (error) {
      el('#debug-action-status').textContent = `手动识图失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  el('#debug-save-image').addEventListener('click', async () => {
    const button = el('#debug-save-image');
    button.disabled = true;
    el('#debug-action-status').textContent = '正在保存当前截图到调试目录…';
    try {
      const result = await api.saveWechatDebugImage();
      el('#debug-action-status').textContent = `已保存调试截图：${result.path}`;
    } catch (error) {
      el('#debug-action-status').textContent = `保存截图失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
})();
