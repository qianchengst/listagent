(() => {
  const api = window.listagent;
  const view = new URLSearchParams(window.location.search).get('view');

  function createThinkingDots() {
    const dots = document.createElement('span');
    dots.className = 'thinking-dots';
    dots.setAttribute('aria-hidden', 'true');
    dots.innerHTML = '<span></span><span></span><span></span>';
    return dots;
  }

  function keepThinkingVisible(startedAt, minimumMs = 320) {
    const remaining = Math.max(0, minimumMs - (Date.now() - startedAt));
    return remaining ? new Promise((resolve) => setTimeout(resolve, remaining)) : Promise.resolve();
  }

  function renderMedia(image, video, emptyState, media) {
    const asset = media && media.url ? media : null;
    image.hidden = true;
    video.hidden = true;
    video.pause();
    video.loop = true;
    video.onended = null;
    if (emptyState) emptyState.hidden = Boolean(asset);
    if (!asset) return;
    if (asset.type === 'webm') {
      if (video.src !== asset.url) video.src = asset.url;
      video.hidden = false;
      video.play().catch(() => {});
      return;
    }
    if (image.src !== asset.url) image.src = asset.url;
    image.hidden = false;
  }

  async function startPet() {
    const root = document.querySelector('#pet-app');
    root.hidden = false;
    const shell = document.querySelector('#pet-shell');
    const image = document.querySelector('#pet-image');
    const video = document.querySelector('#pet-video');
    let config;
    let moving = false;
    let dragging = false;
    let dragReady = false;
    let dragMoved = false;
    let clickStartedWhileStatic = false;
    let rightClickTimer;
    let lastRightClickAt = 0;
    let pointerOffset = { x: 0, y: 0 };
    let pointerStart = { x: 0, y: 0 };
    let deleteAnimationPlaying = false;
    let deleteAnimationTimer;
    let deleteAnimationFallbackTimer;
    let interactionPlaying = false;
    let interactionTimer;
    let interactionFallbackTimer;
    let pendingMovementState;
    let activeMediaState = 'idle';
    let staticPose = 'idle';
    let perched = false;
    let resting = false;
    let lastPetScale;

    function stateScale(state) {
      const master = Number(config?.pet?.masterScale ?? config?.pet?.scale ?? 1);
      const individual = Number(config?.pet?.[`${state}Scale`] ?? 1);
      return Math.min(2, Math.max(0.2, master * individual));
    }

    function applyPetScale(state) {
      activeMediaState = state;
      const scale = stateScale(state);
      shell.style.setProperty('--pet-scale', String(scale));
      if (scale !== lastPetScale) {
        lastPetScale = scale;
        api.setPetScale(scale);
      }
    }

    function drawPet() {
      if (deleteAnimationPlaying || interactionPlaying) return;
      const movingAsset = config?.pet.moving;
      const idleAsset = config?.pet.idle;
      const standingAsset = config?.pet.standing;
      const restAsset = config?.pet.rest;
      const useMoving = moving && movingAsset?.url;
      // If no dedicated moving asset is configured, keep showing whichever
      // static pose is available instead of making the pet disappear.
      const useRest = !moving && resting && !perched && restAsset?.url;
      const useStanding = !useRest && standingAsset?.url && (staticPose === 'standing' || !idleAsset?.url);
      const asset = useMoving
        ? movingAsset
        : useRest ? restAsset : useStanding ? standingAsset : idleAsset;
      applyPetScale(useMoving ? 'moving' : useRest ? 'rest' : useStanding ? 'standing' : 'idle');
      shell.classList.toggle('resting', Boolean(resting && !moving && !perched));
      renderMedia(image, video, null, asset);
    }

    function finishInteraction() {
      if (!interactionPlaying) return;
      interactionPlaying = false;
      if (interactionTimer) clearTimeout(interactionTimer);
      if (interactionFallbackTimer) clearTimeout(interactionFallbackTimer);
      interactionTimer = undefined;
      interactionFallbackTimer = undefined;
      image.onload = null;
      video.onended = null;
      video.loop = true;
      const pending = pendingMovementState;
      pendingMovementState = undefined;
      if (pending) {
        moving = pending.isMoving === true;
        perched = pending.perched === true;
        if (!moving) {
          staticPose = perched
            ? 'idle'
            : (config?.pet?.standing?.url && Math.random() < 0.5 ? 'standing' : 'idle');
        }
      }
      drawPet();
    }

    function playInteraction() {
      const asset = config?.pet.interaction;
      if (!asset?.url || interactionPlaying || deleteAnimationPlaying) return false;
      interactionPlaying = true;
      pendingMovementState = undefined;
      applyPetScale('interaction');
      image.hidden = true;
      video.hidden = true;
      video.pause();
      if (asset.type === 'webm') {
        video.loop = false;
        video.onended = finishInteraction;
        video.src = asset.url;
        video.hidden = false;
        video.currentTime = 0;
        video.play().catch(finishInteraction);
        interactionTimer = setTimeout(finishInteraction, 12000);
      } else {
        image.src = '';
        image.onload = () => {
          image.onload = null;
          interactionTimer = setTimeout(finishInteraction, Math.max(150, Number(asset.durationMs) || 3200));
        };
        image.src = asset.url;
        image.hidden = false;
        interactionFallbackTimer = setTimeout(finishInteraction, 15000);
      }
      return true;
    }

    function finishDeleteAnimation() {
      if (!deleteAnimationPlaying) return;
      deleteAnimationPlaying = false;
      if (deleteAnimationTimer) clearTimeout(deleteAnimationTimer);
      if (deleteAnimationFallbackTimer) clearTimeout(deleteAnimationFallbackTimer);
      deleteAnimationTimer = undefined;
      deleteAnimationFallbackTimer = undefined;
      image.onload = null;
      video.onended = null;
      video.loop = true;
      drawPet();
      api.deleteAnimationFinished();
    }

    function playDeleteAnimation(asset) {
      if (!asset?.url || deleteAnimationPlaying) return;
      deleteAnimationPlaying = true;
      applyPetScale('delete');
      if (deleteAnimationTimer) clearTimeout(deleteAnimationTimer);
      if (deleteAnimationFallbackTimer) clearTimeout(deleteAnimationFallbackTimer);
      image.hidden = true;
      video.hidden = true;
      video.pause();
      if (asset.type === 'webm') {
        video.loop = false;
        video.onended = finishDeleteAnimation;
        video.src = asset.url;
        video.hidden = false;
        video.currentTime = 0;
        video.play().catch(finishDeleteAnimation);
        deleteAnimationTimer = setTimeout(finishDeleteAnimation, 8000);
      } else {
        image.src = '';
        image.onload = () => {
          image.onload = null;
          deleteAnimationTimer = setTimeout(finishDeleteAnimation, Math.max(150, Number(asset.durationMs) || 3200));
        };
        image.src = asset.url;
        image.hidden = false;
        // Keep a hard upper bound for malformed GIF metadata or a failed load.
        deleteAnimationFallbackTimer = setTimeout(finishDeleteAnimation, 12000);
      }
    }
    const apply = (nextConfig) => {
      config = nextConfig;
      resting = config?.automation?.restMode === true;
      drawPet();
    };
    config = await api.getConfig();
    apply(config);
    api.onConfigChanged(apply);
    api.onPetMovementState((state) => {
      const payload = typeof state === 'boolean' ? { isMoving: state, perched: false } : (state || {});
      if (interactionPlaying) {
        pendingMovementState = payload;
        return;
      }
      if (!dragging && !deleteAnimationPlaying) {
        moving = payload.isMoving === true;
        perched = payload.perched === true;
        if (!moving) {
          staticPose = perched
            ? 'idle'
            : (config?.pet?.standing?.url && Math.random() < 0.5 ? 'standing' : 'idle');
        }
        drawPet();
      }
    });
    api.onDeleteAnimation(playDeleteAnimation);

    shell.addEventListener('pointerdown', async (event) => {
      // Left button is reserved exclusively for dragging. Right-button
      // interactions are handled on pointerup so single/double clicks can be
      // distinguished without ever starting a drag.
      if (event.button === 2) {
        event.preventDefault();
        return;
      }
      if (event.button !== 0 || dragging || interactionPlaying || deleteAnimationPlaying) return;
      event.preventDefault();
      dragging = true;
      dragReady = false;
      dragMoved = false;
      clickStartedWhileStatic = !moving;
      pointerStart = { x: event.screenX, y: event.screenY };
      moving = true;
      perched = false;
      shell.classList.add('dragging');
      drawPet();
      const bounds = await api.startPetDrag();
      if (!dragging) return;
      pointerOffset = { x: event.screenX - bounds.x, y: event.screenY - bounds.y };
      dragReady = true;
      shell.setPointerCapture?.(event.pointerId);
    });
    shell.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      if (Math.hypot(event.screenX - pointerStart.x, event.screenY - pointerStart.y) > 5) dragMoved = true;
      if (!dragReady) return;
      api.movePet(event.screenX - pointerOffset.x, event.screenY - pointerOffset.y);
    });
    const stopDragging = () => {
      if (!dragging) return;
      dragging = false;
      dragReady = false;
      moving = false;
      shell.classList.remove('dragging');
      drawPet();
      api.endPetDrag(dragMoved);
    };
    shell.addEventListener('pointerup', (event) => {
      if (event.button === 2) {
        event.preventDefault();
        const now = Date.now();
        const isDoubleRightClick = now - lastRightClickAt < 500;
        clearTimeout(rightClickTimer);
        if (isDoubleRightClick) {
          lastRightClickAt = 0;
          stopDragging();
          api.openConsole();
        } else {
          lastRightClickAt = now;
          rightClickTimer = setTimeout(() => {
            lastRightClickAt = 0;
            api.openBubbleChat();
          }, 350);
        }
        return;
      }
      const wasClick = !dragMoved;
      stopDragging();
      // A left click without movement plays the optional one-shot interaction
      // animation.  Actual dragging remains unchanged.
      if (wasClick && clickStartedWhileStatic) playInteraction();
    });
    shell.addEventListener('pointercancel', stopDragging);
    shell.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });
  }

  async function startBubble() {
    const root = document.querySelector('#bubble-app');
    root.hidden = false;
    const messages = document.querySelector('#bubble-messages');
    const input = document.querySelector('#bubble-input');
    const send = document.querySelector('#bubble-send');
    const name = document.querySelector('#bubble-name');
    const initialGreeting = document.querySelector('#bubble-initial-greeting');
    let sending = false;
    let thinkingItem;
    let thinkingCount = 0;
    let historyRevision = 0;
    let historyReady = false;
    let pendingHistory;
    const scroll = () => { messages.scrollTop = messages.scrollHeight; };
    const addMessage = (role, text) => {
      const item = document.createElement('div');
      item.className = `bubble-message ${role}`;
      item.textContent = text;
      messages.append(item);
      scroll();
      return item;
    };
    const showThinking = () => {
      thinkingCount += 1;
      if (thinkingItem) return;
      initialGreeting.hidden = true;
      thinkingItem = addMessage('assistant', '');
      thinkingItem.classList.add('thinking-message');
      thinkingItem.classList.add('thinking-indicator');
      thinkingItem.setAttribute('role', 'status');
      thinkingItem.setAttribute('aria-label', '正在思考');
      thinkingItem.append(createThinkingDots());
    };
    const hideThinking = () => {
      thinkingCount = Math.max(0, thinkingCount - 1);
      if (thinkingCount > 0) return;
      thinkingItem?.remove();
      thinkingItem = undefined;
    };
    const renderHistory = (history) => {
      (Array.isArray(history) ? history : []).forEach((message) => {
        if (message?.role === 'user' || message?.role === 'assistant') addMessage(message.role, message.content || '');
      });
    };
    const replaceHistory = (history) => {
      if (!historyReady) {
        pendingHistory = Array.isArray(history) ? history : [];
        return;
      }
      const wasThinking = Boolean(thinkingItem);
      historyRevision += 1;
      [...messages.children].forEach((item) => {
        if (item !== initialGreeting) item.remove();
      });
      thinkingItem = undefined;
      thinkingCount = 0;
      initialGreeting.hidden = true;
      renderHistory(Array.isArray(history) ? history : []);
      if (!Array.isArray(history) || history.length === 0) {
        initialGreeting.textContent = '你好，想聊点什么？';
        initialGreeting.hidden = false;
      }
      if (wasThinking) showThinking();
      scroll();
    };
    api.onChatHistoryChanged(replaceHistory);
    api.onWellbeingMessage((payload) => {
      const text = typeof payload === 'string' ? payload : payload?.text;
      if (!text) return;
      initialGreeting.hidden = true;
      const item = addMessage('assistant', String(text).trim());
      item.classList.add('wellbeing-message');
    });
    try {
      const config = await api.getConfig();
      name.textContent = config.persona.name || '桌宠';
      document.documentElement.dataset.skin = ['classic', 'refined', 'reference', 'pepe'].includes(config.ui?.skin) ? config.ui.skin : 'classic';
    } catch { /* The chat can still open while settings are unavailable. */ }
    let history = [];
    try { history = await api.getChatHistory(); } catch { /* use an empty transcript if persistence is unavailable. */ }
    if (Array.isArray(pendingHistory)) history = pendingHistory;
    history = Array.isArray(history) ? history : [];
    historyReady = true;
    renderHistory(history);
    if (history.length === 0) {
      const thinkingStartedAt = Date.now();
      showThinking();
      api.generateGreeting('bubble').then(async (greeting) => {
        await keepThinkingVisible(thinkingStartedAt);
        if (greeting) {
          initialGreeting.textContent = greeting;
        }
        initialGreeting.hidden = false;
      }).catch(async () => {
        await keepThinkingVisible(thinkingStartedAt);
        initialGreeting.hidden = false;
      }).finally(hideThinking);
    } else {
      initialGreeting.hidden = true;
    }
    api.onConfigChanged((next) => {
      name.textContent = next.persona?.name || '桌宠';
      document.documentElement.dataset.skin = ['classic', 'refined', 'reference', 'pepe'].includes(next.ui?.skin) ? next.ui.skin : 'classic';
    });
    async function submit() {
      const text = input.value.trim();
      if (!text || sending) return;
      sending = true;
      input.value = '';
      send.disabled = true;
      addMessage('user', text);
      showThinking();
      try {
        const answer = await api.chat(text);
        if (answer.content) addMessage('assistant', answer.content);
        if (answer.actions?.length) addMessage('assistant', '确认弹窗已打开，请在弹窗中选择是否执行。');
        if (!answer.content && !answer.actions?.length) addMessage('assistant', '我暂时没有得到可显示的回复。');
      } catch (error) {
        addMessage('error', `抱歉，无法完成这次请求：${error.message}`);
      } finally {
        hideThinking();
        sending = false;
        send.disabled = false;
        input.focus();
      }
    }
    document.querySelector('#bubble-form').addEventListener('submit', (event) => { event.preventDefault(); submit(); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
    });
    document.querySelector('#bubble-close').addEventListener('click', () => api.closeBubbleChat());
    input.focus();
    scroll();
  }

  async function startConfirmation() {
    const root = document.querySelector('#confirmation-app');
    root.hidden = false;
    const actionList = document.querySelector('#confirmation-actions');
    const status = document.querySelector('#confirmation-status');
    const intro = document.querySelector('#confirmation-intro');
    const close = document.querySelector('#confirmation-close');
    let actions = [];
    let busy = false;
    api.onActionConfirmation((nextActions) => render(nextActions));

    const applyConfirmationConfig = (config) => {
      document.documentElement.dataset.skin = ['classic', 'refined', 'reference', 'pepe'].includes(config?.ui?.skin) ? config.ui.skin : 'classic';
    };
    try { applyConfirmationConfig(await api.getConfig()); } catch { /* use classic skin fallback */ }
    api.onConfigChanged(applyConfirmationConfig);

    function render(nextActions) {
      actions = Array.isArray(nextActions) ? nextActions.filter((action) => action?.id) : [];
      actionList.innerHTML = '';
      actions.forEach((action) => {
        const card = document.createElement('article');
        card.className = 'confirmation-action';
        const icon = document.createElement('span');
        icon.className = 'confirmation-action-icon';
        icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7.5h14v12H5zM8 7.5V5h8v2.5M9 12h6M9 15h4"/></svg>';
        const copy = document.createElement('div');
        copy.className = 'confirmation-action-copy';
        const description = document.createElement('p');
        description.className = 'confirmation-action-description';
        description.textContent = action.description || '修改项目文件';
        const state = document.createElement('p');
        state.className = 'confirmation-action-state';
        const controls = document.createElement('div');
        controls.className = 'confirmation-action-controls';
        const reject = document.createElement('button');
        reject.className = 'outline-button';
        reject.textContent = '拒绝修改';
        const approve = document.createElement('button');
        approve.className = 'primary-button';
        approve.textContent = '确认执行';
        if (action.invalidArguments) {
          approve.disabled = true;
          state.textContent = '参数无效，无法执行。';
        }
        const resolve = async (approved) => {
          if (busy) return;
          busy = true;
          reject.disabled = true;
          approve.disabled = true;
          state.textContent = approved ? '正在执行…' : '正在取消…';
          try {
            const answer = await api.decideAction(action.id, approved);
            actions = actions.filter((item) => item.id !== action.id);
            if (Array.isArray(answer.actions) && answer.actions.length) actions.push(...answer.actions);
            if (actions.length) {
              render(actions);
              status.textContent = answer.toolResult || '还有一项操作等待确认。';
            } else {
              intro.textContent = approved ? '操作已处理，结果如下。' : '操作已拒绝，没有修改文件。';
              status.textContent = answer.content || answer.toolResult || (approved ? '操作已完成。' : '已取消操作。');
              actionList.innerHTML = '';
            }
          } catch (error) {
            state.textContent = '执行失败';
            status.textContent = `操作未完成：${error.message}`;
          } finally {
            busy = false;
          }
        };
        reject.addEventListener('click', () => resolve(false));
        approve.addEventListener('click', () => resolve(true));
        controls.append(reject, approve);
        copy.append(description, state, controls);
        card.append(icon, copy);
        actionList.append(card);
      });
      close.hidden = actions.length > 0;
      if (actions.length) status.textContent = '';
    }

    close.addEventListener('click', () => api.closeConfirmation());
  }

  async function startConsole() {
    const root = document.querySelector('#console-app');
    root.hidden = false;
    const el = (selector) => document.querySelector(selector);
    const messages = el('#messages');
    const updateProgress = el('#update-progress');
    const initialGreeting = el('#console-initial-greeting');
    const initialGreetingRow = initialGreeting.closest('.message');
    let config;
    let sending = false;
    let thinkingItem;
    let thinkingCount = 0;
    let historyRevision = 0;
    let historyReady = false;
    let pendingHistory;
    const movementPauseStatus = el('#movement-pause-status');
    const MOVE_PAUSE_MIN_SECONDS = 10;
    const MOVE_PAUSE_MAX_SECONDS = 10 * 60;
    const MOVEMENT_SLIDER_MIN_GAP = 4;
    const movementPauseToSlider = (milliseconds) => {
      const seconds = Math.min(MOVE_PAUSE_MAX_SECONDS, Math.max(MOVE_PAUSE_MIN_SECONDS, Number(milliseconds) / 1000 || 30));
      return Math.round(Math.log(seconds / MOVE_PAUSE_MIN_SECONDS) / Math.log(MOVE_PAUSE_MAX_SECONDS / MOVE_PAUSE_MIN_SECONDS) * 100);
    };
    const movementPauseFromSlider = (value) => {
      const ratio = Math.min(100, Math.max(0, Number(value) || 0)) / 100;
      // The settings service stores durations in milliseconds. Keep the
      // logarithmic slider math in seconds, then convert exactly once here.
      return Math.round(MOVE_PAUSE_MIN_SECONDS * (MOVE_PAUSE_MAX_SECONDS / MOVE_PAUSE_MIN_SECONDS) ** ratio * 1000);
    };
    const formatPauseDuration = (milliseconds) => {
      const seconds = Math.max(MOVE_PAUSE_MIN_SECONDS, Math.round(Number(milliseconds) / 1000));
      if (seconds < 60) return `${seconds} 秒`;
      const minutes = Math.floor(seconds / 60);
      const restSeconds = seconds % 60;
      return restSeconds ? `${minutes} 分 ${restSeconds} 秒` : `${minutes} 分钟`;
    };
    const updateMovementPauseLabels = () => {
      const minInput = el('#movement-pause-min');
      const maxInput = el('#movement-pause-max');
      let minSlider = Math.min(100 - MOVEMENT_SLIDER_MIN_GAP, Math.max(0, Number(minInput?.value) || 0));
      let maxSlider = Math.min(100, Math.max(0, Number(maxInput?.value) || 0));
      if (maxSlider - minSlider < MOVEMENT_SLIDER_MIN_GAP) {
        if (minSlider + MOVEMENT_SLIDER_MIN_GAP <= 100) maxSlider = minSlider + MOVEMENT_SLIDER_MIN_GAP;
        else minSlider = maxSlider - MOVEMENT_SLIDER_MIN_GAP;
      }
      minInput.value = minSlider;
      maxInput.value = maxSlider;
      const minMs = movementPauseFromSlider(minSlider);
      const maxMs = movementPauseFromSlider(maxSlider);
      const track = document.querySelector('.dual-range');
      track?.style.setProperty('--range-start', `${minSlider}%`);
      track?.style.setProperty('--range-end', `${maxSlider}%`);
      const minHandle = el('#movement-pause-min-handle');
      const maxHandle = el('#movement-pause-max-handle');
      if (minHandle) {
        minHandle.style.left = `${minSlider}%`;
        minHandle.setAttribute('aria-valuenow', String(minSlider));
        minHandle.setAttribute('aria-valuetext', formatPauseDuration(minMs));
      }
      if (maxHandle) {
        maxHandle.style.left = `${maxSlider}%`;
        maxHandle.setAttribute('aria-valuenow', String(maxSlider));
        maxHandle.setAttribute('aria-valuetext', formatPauseDuration(maxMs));
      }
      const minOutput = el('#movement-pause-min-output');
      const maxOutput = el('#movement-pause-max-output');
      if (minOutput) {
        minOutput.value = formatPauseDuration(minMs);
        minOutput.textContent = minOutput.value;
      }
      if (maxOutput) {
        maxOutput.value = formatPauseDuration(maxMs);
        maxOutput.textContent = maxOutput.value;
      }
    };

    function formatMegabytes(bytes) {
      const value = Math.max(0, Number(bytes) || 0) / (1024 * 1024);
      return value >= 100 ? value.toFixed(0) : value.toFixed(1);
    }

    function renderUpdateProgress(progress = {}) {
      if (!updateProgress) return;
      const downloaded = Math.max(0, Number(progress.downloaded) || 0);
      const total = Math.max(0, Number(progress.total) || 0);
      updateProgress.hidden = false;
      updateProgress.dataset.state = progress.phase || 'download';
      updateProgress.textContent = `${formatMegabytes(downloaded)} MB / ${total > 0 ? `${formatMegabytes(total)} MB` : '… MB'}`;
    }

    api.onUpdateProgress(renderUpdateProgress);

    function applyConfig(next) {
      config = next;
      const skin = ['classic', 'refined', 'reference', 'pepe'].includes(config.ui?.skin) ? config.ui.skin : 'classic';
      document.documentElement.dataset.skin = skin;
      el('#chat-name').textContent = config.persona.name;
      el('#persona-name').value = config.persona.name;
      el('#persona-relationship').value = config.persona.relationship || '';
      el('#persona-description').value = config.persona.description;
      el('#persona-examples').value = config.persona.examples;
      el('#api-text-base-url').value = config.api.textBaseUrl;
      el('#api-text-model').value = config.api.textModel;
      el('#api-vision-base-url').value = config.api.visionBaseUrl || '';
      el('#api-vision-model').value = config.api.visionModel || '';
      el('#temperature').value = config.api.temperature;
      el('#temperature-output').value = config.api.temperature;
      el('#update-repository').value = config.update?.repository || '';
      el('#text-key-state').textContent = config.api.textApiKeySet ? '文本 API Key 已保存（为安全起见不回显）' : '文本 API Key 尚未保存';
      el('#vision-key-state').textContent = config.api.visionApiKeySet ? '视觉 API Key 已保存（为安全起见不回显）' : '视觉 API Key 尚未保存';
      el('#automation-enabled').checked = config.automation.enabled;
      el('#automation-auto-execute').checked = config.automation.autoExecute === true;
      el('#rest-mode').checked = config.automation.restMode === true;
      const restOffset = Math.round(Number(config.automation.restOffsetPx) || 0);
      el('#rest-offset').value = restOffset;
      el('#rest-offset-output').value = restOffset === 0 ? '贴底' : `${restOffset} px`;
      el('#rest-offset-output').textContent = el('#rest-offset-output').value;
      el('#wellbeing-enabled').checked = config.automation.wellbeingEnabled !== false;
      const wellbeingInterval = Math.round((Number(config.automation.wellbeingMinIntervalMs) || 45 * 60 * 1000) / 60000);
      const wellbeingThreshold = Math.round((Number(config.automation.wellbeingLongUseThresholdMs) || 90 * 60 * 1000) / 60000);
      el('#wellbeing-interval').value = wellbeingInterval;
      el('#wellbeing-interval-output').value = `${wellbeingInterval} 分钟`;
      el('#wellbeing-interval-output').textContent = el('#wellbeing-interval-output').value;
      el('#wellbeing-threshold').value = wellbeingThreshold;
      el('#wellbeing-threshold-output').value = `${wellbeingThreshold} 分钟`;
      el('#wellbeing-threshold-output').textContent = el('#wellbeing-threshold-output').value;
      el('#wechat-auto-reply').checked = config.automation.wechatAutoReply === true;
      el('#wechat-interval').value = Math.round((Number(config.automation.wechatIntervalMs) || 5000) / 1000);
      const pauseMin = movementPauseToSlider(Number(config.automation.movementPauseMinMs) || 30000);
      const pauseMax = movementPauseToSlider(Number(config.automation.movementPauseMaxMs) || 90000);
      el('#movement-pause-min').value = pauseMin;
      el('#movement-pause-max').value = Math.max(pauseMin, pauseMax);
      updateMovementPauseLabels();
      const perchOffset = Math.round(Number(config.automation.perchOffsetPx) || 0);
      el('#perch-offset').value = perchOffset;
      el('#perch-offset-output').value = `${perchOffset} px`;
      el('#perch-offset-output').textContent = el('#perch-offset-output').value;
      el('#start-wechat-monitor').disabled = config.automation.wechatMonitorEnabled === true;
      el('#stop-wechat-monitor').disabled = config.automation.wechatMonitorEnabled !== true;
      document.querySelectorAll('input[name="skin"]').forEach((input) => {
        input.checked = input.value === skin;
        input.closest('.skin-option')?.classList.toggle('selected', input.checked);
      });
      renderMedia(el('#idle-preview-image'), el('#idle-preview-video'), el('#idle-preview-empty'), config.pet.idle);
      renderMedia(el('#standing-preview-image'), el('#standing-preview-video'), el('#standing-preview-empty'), config.pet.standing);
      renderMedia(el('#interaction-preview-image'), el('#interaction-preview-video'), el('#interaction-preview-empty'), config.pet.interaction);
      renderMedia(el('#moving-preview-image'), el('#moving-preview-video'), el('#moving-preview-empty'), config.pet.moving);
      renderMedia(el('#rest-preview-image'), el('#rest-preview-video'), el('#rest-preview-empty'), config.pet.rest);
      renderMedia(el('#delete-preview-image'), el('#delete-preview-video'), el('#delete-preview-empty'), config.pet.deleteAnimation);
      const scaleValues = {
        master: Number(config.pet.masterScale ?? config.pet.scale ?? 1),
        idle: Number(config.pet.idleScale ?? 1),
        standing: Number(config.pet.standingScale ?? 1),
        interaction: Number(config.pet.interactionScale ?? 1),
        moving: Number(config.pet.movingScale ?? 1),
        rest: Number(config.pet.restScale ?? 1),
        delete: Number(config.pet.deleteScale ?? 1)
      };
      for (const [key, value] of Object.entries(scaleValues)) {
        const input = el(`#pet-scale-${key}`);
        const output = el(`#pet-scale-${key}-output`);
        if (input) input.value = Math.round(Math.min(2, Math.max(0.2, value)) * 100);
        if (output) {
          output.value = `${Math.round(Math.min(2, Math.max(0.2, value)) * 100)}%`;
          output.textContent = output.value;
        }
      }
    }

    function scrollMessages() {
      messages.scrollTop = messages.scrollHeight;
    }

    function addMessage(role, text) {
      const row = document.createElement('div');
      row.className = `message ${role}`;
      if (role === 'assistant') {
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.innerHTML = '<span class="avatar-glyph">✦</span><svg class="avatar-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 14.4 9l5.9 1-4.4 4.1 1 5.9-4.9-2.8-4.9 2.8 1-5.9-4.4-4.1 5.9-1L12 3.5Z"/></svg>';
        row.append(avatar);
      }
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = text;
      row.append(bubble);
      messages.append(row);
      scrollMessages();
      return row;
    }

    function showThinking() {
      thinkingCount += 1;
      if (thinkingItem) return;
      initialGreetingRow.hidden = true;
      thinkingItem = addMessage('assistant', '');
      thinkingItem.classList.add('thinking-message');
      const bubble = thinkingItem.querySelector('.bubble');
      bubble.classList.add('thinking-indicator');
      bubble.setAttribute('role', 'status');
      bubble.setAttribute('aria-label', '正在思考');
      bubble.append(createThinkingDots());
    }

    function hideThinking() {
      thinkingCount = Math.max(0, thinkingCount - 1);
      if (thinkingCount > 0) return;
      thinkingItem?.remove();
      thinkingItem = undefined;
    }

    function renderHistory(history) {
      (Array.isArray(history) ? history : []).forEach((message) => {
        if (message?.role === 'user' || message?.role === 'assistant') addMessage(message.role, message.content || '');
      });
    }

    function replaceHistory(history) {
      if (!historyReady) {
        pendingHistory = Array.isArray(history) ? history : [];
        return;
      }
      const wasThinking = Boolean(thinkingItem);
      historyRevision += 1;
      [...messages.children].forEach((row) => {
        if (row !== initialGreetingRow) row.remove();
      });
      thinkingItem = undefined;
      thinkingCount = 0;
      initialGreetingRow.hidden = true;
      renderHistory(Array.isArray(history) ? history : []);
      if (!Array.isArray(history) || history.length === 0) {
        initialGreeting.textContent = '你好！配置好模型连接后，我就可以陪你对话，并在你确认后完成有限的电脑操作。';
        initialGreetingRow.hidden = false;
      }
      if (wasThinking) showThinking();
      scrollMessages();
    }
    api.onChatHistoryChanged(replaceHistory);

    async function submitChat() {
      const input = el('#chat-input');
      const text = input.value.trim();
      if (!text || sending) return;
      sending = true;
      input.value = '';
      input.style.height = 'auto';
      el('#send').disabled = true;
      addMessage('user', text);
      showThinking();
      try {
        const answer = await api.chat(text);
        if (answer.content) addMessage('assistant', answer.content);
        if (!answer.content && (!answer.actions || answer.actions.length === 0)) addMessage('assistant', '我暂时没有得到可显示的回复。');
        if (answer.actions?.length) addMessage('assistant', '确认弹窗已打开，请在弹窗中选择是否执行。');
      } catch (error) {
        addMessage('assistant', `抱歉，无法完成这次请求：${error.message}`);
      } finally {
        hideThinking();
        sending = false;
        el('#send').disabled = false;
        input.focus();
      }
    }

    async function savePersona() {
      const next = await api.saveConfig({
        persona: {
          name: el('#persona-name').value,
          relationship: el('#persona-relationship').value,
          description: el('#persona-description').value,
          examples: el('#persona-examples').value
        }
      });
      applyConfig(next);
    }

    async function saveConnection() {
      const next = await api.saveConfig({
        api: {
          textBaseUrl: el('#api-text-base-url').value,
          textModel: el('#api-text-model').value,
          visionBaseUrl: el('#api-vision-base-url').value,
          visionModel: el('#api-vision-model').value,
          textApiKey: el('#api-text-key').value,
          visionApiKey: el('#api-vision-key').value,
          temperature: Number(el('#temperature').value)
        },
        update: { repository: el('#update-repository').value }
      });
      el('#api-text-key').value = '';
      el('#api-vision-key').value = '';
      applyConfig(next);
    }

    async function importPersonaText(field) {
      const status = el('#persona-import-status');
      status.textContent = '正在选择文本文件…';
      try {
        const result = await api.importPersonaText(field);
        applyConfig(result.config);
        status.textContent = result.imported
          ? (field === 'description' ? '人格设定 TXT 已导入。' : '语言示例 TXT 已导入。')
          : '已取消导入。';
      } catch (error) {
        status.textContent = `导入失败：${error.message}`;
      }
    }

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
        document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${tab.dataset.tab}`));
      });
    });
    el('#chat-form').addEventListener('submit', (event) => { event.preventDefault(); submitChat(); });
    el('#chat-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitChat(); }
    });
    el('#chat-input').addEventListener('input', (event) => {
      event.target.style.height = 'auto';
      event.target.style.height = `${Math.min(event.target.scrollHeight, 150)}px`;
    });
    el('#clear-chat').addEventListener('click', async () => {
      await api.clearChat();
      messages.innerHTML = '';
      addMessage('assistant', '本次对话已清空。我们重新开始吧。');
    });
    document.querySelector('[data-save="persona"]').addEventListener('click', savePersona);
    document.querySelector('[data-save="connection"]').addEventListener('click', saveConnection);
    el('#check-updates').addEventListener('click', async () => {
      const status = el('#update-status');
      const install = el('#install-update');
      install.hidden = true;
      if (updateProgress) {
        updateProgress.hidden = true;
        updateProgress.textContent = '';
        updateProgress.dataset.state = '';
      }
      status.textContent = '正在检查 GitHub 更新…';
      try {
        const result = await api.checkForUpdates();
        if (!result.configured) {
          status.textContent = '请先填写 GitHub 更新仓库，例如 your-name/listagent。';
        } else if (!result.updateAvailable) {
          status.textContent = `当前已是最新版本 v${result.currentVersion}。`;
        } else {
          const modeHint = result.mode === 'delta' ? '安装时只下载变化的程序文件' : '该 Release 没有增量清单，将下载完整包';
          status.textContent = `发现新版本 v${result.latestVersion}，${modeHint}。点击“立即更新”。`;
          install.hidden = false;
        }
      } catch (error) {
        status.textContent = `更新检查失败：${error.message}`;
      }
    });
    el('#install-update').addEventListener('click', async () => {
      const status = el('#update-status');
      const button = el('#install-update');
      button.disabled = true;
      status.textContent = '正在获取更新清单并下载变化文件，完成后会自动重启…';
      renderUpdateProgress({ phase: 'starting', downloaded: 0, total: 0 });
      try {
        await api.installUpdate();
      } catch (error) {
        button.disabled = false;
        if (updateProgress) {
          updateProgress.hidden = false;
          updateProgress.dataset.state = 'error';
        }
        status.textContent = `更新失败：${error.message}`;
      }
    });
    el('#choose-idle-pet').addEventListener('click', async () => applyConfig(await api.choosePetMedia('idle')));
    el('#choose-standing-pet').addEventListener('click', async () => applyConfig(await api.choosePetMedia('standing')));
    el('#choose-interaction-pet').addEventListener('click', async () => applyConfig(await api.choosePetMedia('interaction')));
    el('#choose-moving-pet').addEventListener('click', async () => applyConfig(await api.choosePetMedia('moving')));
    el('#choose-rest-pet').addEventListener('click', async () => applyConfig(await api.choosePetMedia('rest')));
    el('#choose-delete-pet').addEventListener('click', async () => applyConfig(await api.choosePetMedia('delete')));
    for (const key of ['master', 'idle', 'standing', 'interaction', 'moving', 'rest', 'delete']) {
      const input = el(`#pet-scale-${key}`);
      const output = el(`#pet-scale-${key}-output`);
      input?.addEventListener('input', (event) => {
        if (output) {
          output.value = `${event.target.value}%`;
          output.textContent = output.value;
        }
      });
      input?.addEventListener('change', async (event) => {
        const patchKey = key === 'master' ? 'masterScale' : `${key}Scale`;
        const next = await api.saveConfig({ pet: { [patchKey]: Number(event.target.value) / 100 } });
        applyConfig(next);
      });
    }
    el('#import-persona-description').addEventListener('click', () => importPersonaText('description'));
    el('#import-persona-examples').addEventListener('click', () => importPersonaText('examples'));
    el('#temperature').addEventListener('input', (event) => { el('#temperature-output').value = event.target.value; });
    el('#automation-enabled').addEventListener('change', async (event) => {
      applyConfig(await api.saveConfig({ automation: { enabled: event.target.checked } }));
    });
    el('#automation-auto-execute').addEventListener('change', async (event) => {
      applyConfig(await api.saveConfig({ automation: { autoExecute: event.target.checked } }));
    });
    el('#rest-mode').addEventListener('change', async (event) => {
      applyConfig(await api.saveConfig({ automation: { restMode: event.target.checked } }));
    });
    el('#rest-offset').addEventListener('input', (event) => {
      const value = Math.max(0, Math.min(200, Number(event.target.value) || 0));
      el('#rest-offset-output').value = value === 0 ? '贴底' : `${value} px`;
      el('#rest-offset-output').textContent = el('#rest-offset-output').value;
    });
    el('#rest-offset').addEventListener('change', async (event) => {
      const value = Math.max(0, Math.min(200, Number(event.target.value) || 0));
      event.target.value = value;
      applyConfig(await api.saveConfig({ automation: { restOffsetPx: value } }));
    });
    const saveMovementPauseRange = async () => {
      const minInput = el('#movement-pause-min');
      const maxInput = el('#movement-pause-max');
      let minSlider = Math.min(100, Math.max(0, Number(minInput.value) || 0));
      let maxSlider = Math.min(100, Math.max(0, Number(maxInput.value) || 0));
      minSlider = Math.min(100 - MOVEMENT_SLIDER_MIN_GAP, minSlider);
      maxSlider = Math.max(MOVEMENT_SLIDER_MIN_GAP, maxSlider);
      if (maxSlider - minSlider < MOVEMENT_SLIDER_MIN_GAP) maxSlider = Math.min(100, minSlider + MOVEMENT_SLIDER_MIN_GAP);
      if (maxSlider - minSlider < MOVEMENT_SLIDER_MIN_GAP) minSlider = Math.max(0, maxSlider - MOVEMENT_SLIDER_MIN_GAP);
      minInput.value = minSlider;
      maxInput.value = maxSlider;
      updateMovementPauseLabels();
      if (movementPauseStatus) movementPauseStatus.textContent = `正在保存：${formatPauseDuration(movementPauseFromSlider(minSlider))} – ${formatPauseDuration(movementPauseFromSlider(maxSlider))}`;
      try {
        applyConfig(await api.saveConfig({ automation: {
          movementPauseMinMs: movementPauseFromSlider(minSlider),
          movementPauseMaxMs: movementPauseFromSlider(maxSlider)
        } }));
        if (movementPauseStatus) movementPauseStatus.textContent = '已保存，下一次自然移动将使用新的静止时间范围。';
      } catch (error) {
        if (movementPauseStatus) movementPauseStatus.textContent = `保存失败：${error.message}`;
      }
    };
    const movementRange = el('#movement-pause-range');
    const movementHandles = {
      min: el('#movement-pause-min-handle'),
      max: el('#movement-pause-max-handle')
    };
    const setMovementSlider = (handleName, value) => {
      const minInput = el('#movement-pause-min');
      const maxInput = el('#movement-pause-max');
      let next = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
      const minValue = Math.min(100 - MOVEMENT_SLIDER_MIN_GAP, Math.max(0, Number(minInput.value) || 0));
      const maxValue = Math.min(100, Math.max(MOVEMENT_SLIDER_MIN_GAP, Number(maxInput.value) || 0));
      if (handleName === 'min') next = Math.min(next, maxValue - MOVEMENT_SLIDER_MIN_GAP);
      else next = Math.max(next, minValue + MOVEMENT_SLIDER_MIN_GAP);
      (handleName === 'min' ? minInput : maxInput).value = next;
      updateMovementPauseLabels();
    };
    const movementSliderFromPointer = (event) => {
      const rect = movementRange.getBoundingClientRect();
      if (!rect.width) return 0;
      return Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));
    };
    let movementDrag;
    const beginMovementHandleDrag = (handleName, event) => {
      const handle = movementHandles[handleName];
      if (!handle || movementDrag || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : 1;
      const drag = { handle, pointerId, finished: false };
      movementDrag = drag;
      if (movementPauseStatus) movementPauseStatus.textContent = '正在调整…';
      const move = (moveEvent) => {
        if (Number.isFinite(moveEvent.pointerId) && moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        setMovementSlider(handleName, movementSliderFromPointer(moveEvent));
      };
      const end = (endEvent = {}) => {
        if (drag.finished) return;
        if (Number.isFinite(endEvent.pointerId) && endEvent.pointerId !== pointerId) return;
        drag.finished = true;
        try { handle.releasePointerCapture?.(pointerId); } catch { /* capture may already be released. */ }
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        window.removeEventListener('blur', end);
        document.removeEventListener('mouseup', end);
        movementDrag = undefined;
        void saveMovementPauseRange();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      window.addEventListener('blur', end);
      document.addEventListener('mouseup', end);
      try { handle.setPointerCapture?.(pointerId); } catch { /* pointer capture is optional on older Electron builds. */ }
    };
    Object.entries(movementHandles).forEach(([handleName, handle]) => {
      handle?.addEventListener('pointerdown', (event) => beginMovementHandleDrag(handleName, event));
      handle?.addEventListener('keydown', async (event) => {
        const current = Number(el(`#movement-pause-${handleName}`).value) || 0;
        const step = event.shiftKey ? 10 : 1;
        let next = current;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next -= step;
        else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next += step;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = 100;
        else return;
        event.preventDefault();
        setMovementSlider(handleName, next);
        await saveMovementPauseRange();
      });
    });
    movementRange?.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || movementDrag) return;
      if (event.target.closest('.dual-range-thumb')) return;
      event.preventDefault();
      const target = movementSliderFromPointer(event);
      const minValue = Number(el('#movement-pause-min').value) || 0;
      const maxValue = Number(el('#movement-pause-max').value) || 0;
      const handleName = Math.abs(target - minValue) <= Math.abs(target - maxValue) ? 'min' : 'max';
      setMovementSlider(handleName, target);
      movementHandles[handleName]?.focus();
      if (movementPauseStatus) movementPauseStatus.textContent = '正在保存…';
      void saveMovementPauseRange();
    });
    el('#wellbeing-enabled').addEventListener('change', async (event) => {
      applyConfig(await api.saveConfig({ automation: { wellbeingEnabled: event.target.checked } }));
    });
    el('#wellbeing-interval').addEventListener('input', (event) => {
      el('#wellbeing-interval-output').value = `${event.target.value} 分钟`;
      el('#wellbeing-interval-output').textContent = el('#wellbeing-interval-output').value;
    });
    el('#wellbeing-interval').addEventListener('change', async (event) => {
      const minutes = Math.min(180, Math.max(10, Number(event.target.value) || 45));
      event.target.value = minutes;
      applyConfig(await api.saveConfig({ automation: { wellbeingMinIntervalMs: minutes * 60000 } }));
    });
    el('#wellbeing-threshold').addEventListener('input', (event) => {
      el('#wellbeing-threshold-output').value = `${event.target.value} 分钟`;
      el('#wellbeing-threshold-output').textContent = el('#wellbeing-threshold-output').value;
    });
    el('#wellbeing-threshold').addEventListener('change', async (event) => {
      const minutes = Math.min(240, Math.max(30, Number(event.target.value) || 90));
      event.target.value = minutes;
      applyConfig(await api.saveConfig({ automation: { wellbeingLongUseThresholdMs: minutes * 60000 } }));
    });
    el('#wechat-auto-reply').addEventListener('change', async (event) => {
      applyConfig(await api.saveConfig({ automation: { wechatAutoReply: event.target.checked } }));
    });
    el('#wechat-interval').addEventListener('change', async (event) => {
      const seconds = Math.min(30, Math.max(3, Number(event.target.value) || 5));
      event.target.value = seconds;
      applyConfig(await api.saveConfig({ automation: { wechatIntervalMs: seconds * 1000 } }));
    });
    el('#perch-offset').addEventListener('input', (event) => {
      el('#perch-offset-output').value = `${event.target.value} px`;
      el('#perch-offset-output').textContent = el('#perch-offset-output').value;
    });
    el('#perch-offset').addEventListener('change', async (event) => {
      applyConfig(await api.saveConfig({ automation: { perchOffsetPx: Number(event.target.value) } }));
    });
    el('#perch-pet').addEventListener('click', async () => {
      const status = el('#perch-status');
      status.textContent = '正在寻找置顶窗口…';
      try {
        const result = await api.perchPet();
        status.textContent = result?.title ? `已坐到“${result.title}”窗口上。` : '已坐到置顶窗口上。';
      } catch (error) {
        status.textContent = `暂时无法坐下：${error.message}`;
      }
    });
    document.querySelectorAll('input[name="skin"]').forEach((input) => {
      input.addEventListener('change', async (event) => {
        const skin = ['classic', 'refined', 'reference', 'pepe'].includes(event.target.value) ? event.target.value : 'classic';
        el('#skin-status').textContent = '正在应用皮肤…';
        try {
          applyConfig(await api.saveConfig({ ui: { skin } }));
          el('#skin-status').textContent = skin === 'refined' ? '精修皮肤已启用并保存。' : skin === 'reference' ? '拉普兰德皮肤已启用并保存。' : skin === 'pepe' ? '佩佩皮肤已启用并保存。' : '经典皮肤已启用并保存。';
        } catch (error) {
          el('#skin-status').textContent = `皮肤切换失败：${error.message}`;
        }
      });
    });
    el('#check-wechat').addEventListener('click', async () => {
      const status = el('#wechat-status');
      status.textContent = '正在检查…';
      try {
        const result = await api.wechatStatus();
        const windows = (result.windows || []).filter((item) => item.visible && item.width > 200 && item.height > 100);
        status.textContent = result.running
          ? `微信正在运行：${(result.processes || []).join(', ')}；可用窗口 ${windows.length} 个。`
          : '未检测到微信进程。';
      } catch (error) {
        status.textContent = `检查失败：${error.message}`;
      }
    });
    el('#start-wechat-monitor').addEventListener('click', async () => {
      const status = el('#wechat-monitor-status');
      status.textContent = '正在启动微信监听…';
      try {
        applyConfig(await api.startWechatMonitor());
      } catch (error) {
        status.textContent = `启动失败：${error.message}`;
      }
    });
    el('#stop-wechat-monitor').addEventListener('click', async () => {
      try {
        applyConfig(await api.stopWechatMonitor());
      } catch (error) {
        el('#wechat-monitor-status').textContent = `停止失败：${error.message}`;
      }
    });
    el('#open-wechat-debug').addEventListener('click', () => api.openWechatDebug());
    api.onWechatMonitorEvent((event) => {
      el('#wechat-monitor-status').textContent = event?.message || '';
    });
    el('#quit').addEventListener('click', () => api.quit());

    applyConfig(await api.getConfig());
    let history = [];
    try { history = await api.getChatHistory(); } catch { /* use an empty transcript if persistence is unavailable. */ }
    if (Array.isArray(pendingHistory)) history = pendingHistory;
    history = Array.isArray(history) ? history : [];
    historyReady = true;
    renderHistory(history);
    const hadHistory = history.length > 0;
    const thinkingStartedAt = Date.now();
    showThinking();
    api.generateGreeting('console').then(async (greeting) => {
      await keepThinkingVisible(thinkingStartedAt);
      if (greeting) {
        initialGreetingRow.hidden = true;
        addMessage('assistant', greeting);
      } else {
        initialGreetingRow.hidden = !hadHistory;
      }
    }).catch(async () => {
      await keepThinkingVisible(thinkingStartedAt);
      initialGreetingRow.hidden = !hadHistory;
    }).finally(hideThinking);
    api.onConfigChanged(applyConfig);
  }

  if (view === 'pet') startPet();
  else if (view === 'bubble') startBubble();
  else if (view === 'confirmation') startConfirmation();
  else startConsole();
})();
