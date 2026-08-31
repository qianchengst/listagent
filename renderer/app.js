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

  let activeMessageContextMenu;
  let activeMessageContextCleanup;
  function closeMessageContextMenu() {
    activeMessageContextCleanup?.();
    activeMessageContextCleanup = undefined;
    activeMessageContextMenu?.remove();
    activeMessageContextMenu = undefined;
  }

  function openMessageContextMenu(event, target, { onEdit, onDelete } = {}) {
    event.preventDefault();
    event.stopPropagation();
    closeMessageContextMenu();
    const menu = document.createElement('div');
    menu.className = 'message-context-menu';
    menu.setAttribute('role', 'menu');
    menu.addEventListener('contextmenu', (menuEvent) => menuEvent.preventDefault());
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '修改';
    edit.setAttribute('role', 'menuitem');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '删除';
    remove.setAttribute('role', 'menuitem');
    edit.addEventListener('click', () => {
      closeMessageContextMenu();
      onEdit?.(target);
    });
    remove.addEventListener('click', () => {
      closeMessageContextMenu();
      onDelete?.(target);
    });
    menu.append(edit, remove);
    document.body.append(menu);
    const width = menu.offsetWidth || 112;
    const height = menu.offsetHeight || 76;
    const left = Math.min(Math.max(8, event.clientX), Math.max(8, window.innerWidth - width - 8));
    const top = Math.min(Math.max(8, event.clientY), Math.max(8, window.innerHeight - height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    const outside = (nextEvent) => {
      if (!menu.contains(nextEvent.target)) closeMessageContextMenu();
    };
    const escape = (nextEvent) => {
      if (nextEvent.key === 'Escape') closeMessageContextMenu();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    activeMessageContextMenu = menu;
    activeMessageContextCleanup = () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
    edit.focus();
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
    let nextHistoryIndex = 0;
    let editingMessage;
    const scroll = () => { messages.scrollTop = messages.scrollHeight; };
    const refillInput = (text) => {
      input.value = String(text || '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    };
    const removeRenderedPair = (target) => {
      if (!target || !target.isConnected) return;
      let next = target.nextElementSibling;
      target.remove();
      while (next) {
        const candidate = next;
        next = candidate.nextElementSibling;
        if (candidate.dataset.persisted === 'true') {
          if (candidate.classList.contains('assistant')) candidate.remove();
          break;
        }
      }
    };
    const syncHistoryIndexes = async () => {
      try {
        const history = await api.getChatHistory();
        const entries = Array.isArray(history) ? history : [];
        const nodes = [...messages.children].filter((item) => item.dataset.persisted === 'true');
        nextHistoryIndex = 0;
        entries.forEach((entry, index) => {
          const node = nodes[index];
          if (!node) return;
          const historyIndex = Number.isInteger(Number(entry.historyIndex)) ? Number(entry.historyIndex) : index;
          node.dataset.historyIndex = String(historyIndex);
          nextHistoryIndex = Math.max(nextHistoryIndex, historyIndex + 1);
        });
      } catch { /* best effort; the active transcript remains usable. */ }
    };
    const addMessage = (role, text, options = {}) => {
      const item = document.createElement('div');
      item.className = `bubble-message ${role}`;
      const messageText = String(text || '');
      item.textContent = messageText;
      const persisted = options.persisted !== false && ['user', 'assistant'].includes(role);
      if (persisted) {
        const suppliedIndex = Number(options.historyIndex);
        const historyIndex = Number.isInteger(suppliedIndex) && suppliedIndex >= 0 ? suppliedIndex : nextHistoryIndex;
        item.dataset.persisted = 'true';
        item.dataset.historyIndex = String(historyIndex);
        nextHistoryIndex = Math.max(nextHistoryIndex, historyIndex + 1);
      } else {
        item.dataset.persisted = 'false';
      }
      if (role === 'user') {
        item.classList.add('editable-user-message');
        item.title = '右键选择修改或删除';
        item.addEventListener('contextmenu', (event) => {
          const historyIndex = Number(item.dataset.historyIndex);
          if (!Number.isInteger(historyIndex)) return;
          openMessageContextMenu(event, item, {
            onEdit: () => {
              if (sending) return;
              editingMessage?.element?.classList.remove('editing-message');
              editingMessage = { historyIndex, element: item };
              item.classList.add('editing-message');
              refillInput(messageText);
            },
            onDelete: async () => {
              if (sending) return;
              editingMessage = undefined;
              try {
                const history = await api.removeChatMessage(historyIndex);
                replaceHistory(history);
              } catch (error) {
                addMessage('error', `删除消息失败：${error.message}`, { persisted: false });
              }
            }
          });
        });
      }
      messages.append(item);
      scroll();
      return item;
    };
    const showThinking = () => {
      thinkingCount += 1;
      if (thinkingItem) return;
      initialGreeting.hidden = true;
      thinkingItem = addMessage('assistant', '', { persisted: false });
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
        if (message?.role === 'user' || message?.role === 'assistant') {
          addMessage(message.role, message.content || '', { historyIndex: message.historyIndex });
        }
      });
    };
    const replaceHistory = (history) => {
      if (!historyReady) {
        pendingHistory = Array.isArray(history) ? history : [];
        return;
      }
      const wasThinking = Boolean(thinkingItem);
      historyRevision += 1;
      nextHistoryIndex = 0;
      editingMessage = undefined;
      closeMessageContextMenu();
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
      const item = addMessage('assistant', String(text).trim(), { persisted: false });
      item.classList.add('wellbeing-message');
    });
    api.onPlanReminder((payload) => {
      const text = typeof payload === 'string' ? payload : payload?.text;
      if (!text) return;
      initialGreeting.hidden = true;
      const item = addMessage('assistant', String(text).trim(), { persisted: false });
      item.classList.add('plan-reminder-message');
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
      const editTarget = editingMessage;
      editingMessage = undefined;
      editTarget?.element?.classList.remove('editing-message');
      sending = true;
      input.value = '';
      send.disabled = true;
      if (editTarget) removeRenderedPair(editTarget.element);
      addMessage('user', text);
      showThinking();
      try {
        const answer = editTarget
          ? await api.chat(text, { editHistoryIndex: editTarget.historyIndex })
          : await api.chat(text);
        if (answer.content) addMessage('assistant', answer.content);
        if (answer.actions?.length) addMessage('assistant', '确认弹窗已打开，请在弹窗中选择是否执行。', { persisted: false });
        if (!answer.content && !answer.actions?.length) addMessage('assistant', '我暂时没有得到可显示的回复。', { persisted: false });
        if (editTarget) await syncHistoryIndexes();
      } catch (error) {
        addMessage('error', `抱歉，无法完成这次请求：${error.message}`, { persisted: false });
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
    let nextHistoryIndex = 0;
    let editingMessage;
    const refillInput = (text) => {
      const input = el('#chat-input');
      if (!input) return;
      input.value = String(text || '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    };
    const recordSessionDuration = el('#record-session-duration');
    const recordLifetimeDuration = el('#record-lifetime-duration');
    const recordSessionCount = el('#record-session-count');
    const recordMovementDistance = el('#record-movement-distance');
    const recordConversations = el('#record-conversations');
    const recordTokens = el('#record-tokens');
    const recordTokenBreakdown = el('#record-token-breakdown');
    const recordUpdated = el('#record-updated');
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

    const formatRecordDuration = (milliseconds) => {
      const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
      if (totalSeconds < 60) return `${totalSeconds} 秒`;
      const totalMinutes = Math.floor(totalSeconds / 60);
      if (totalMinutes < 60) return `${totalMinutes} 分钟`;
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
    };
    const formatRecordDistance = (pixels) => {
      const value = Math.max(0, Number(pixels) || 0);
      if (value < 1000) return `${Math.round(value)} px`;
      return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} k px`;
    };
    const formatRecordNumber = (value) => Math.max(0, Math.round(Number(value) || 0)).toLocaleString('zh-CN');
    function applyCompanionRecord(record = {}) {
      if (recordSessionDuration) recordSessionDuration.textContent = formatRecordDuration(record.currentSessionMs);
      if (recordLifetimeDuration) recordLifetimeDuration.textContent = formatRecordDuration(record.activeMs);
      if (recordSessionCount) recordSessionCount.textContent = formatRecordNumber(record.totalSessions);
      if (recordMovementDistance) recordMovementDistance.textContent = formatRecordDistance(record.totalMovementPx);
      if (recordConversations) recordConversations.textContent = formatRecordNumber(record.totalConversations);
      if (recordTokens) recordTokens.textContent = formatRecordNumber(record.totalTokens);
      if (recordTokenBreakdown) {
        const prompt = formatRecordNumber(record.totalPromptTokens);
        const completion = formatRecordNumber(record.totalCompletionTokens);
        const estimated = Number(record.estimatedTokenRequests) > 0 ? `；其中 ${formatRecordNumber(record.estimatedTokenRequests)} 次为估算` : '';
        recordTokenBreakdown.textContent = `${prompt} 输入 / ${completion} 输出${estimated}`;
      }
      if (recordUpdated) {
        const updatedAt = record.updatedAt ? new Date(record.updatedAt) : null;
        recordUpdated.textContent = updatedAt && !Number.isNaN(updatedAt.getTime())
          ? `最近更新：${updatedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · 数据仅保存在本机`
          : '数据仅保存在本机';
      }
    }
    api.onCompanionRecordChanged(applyCompanionRecord);

    // ---- Planning workspace -------------------------------------------------
    let plans = null;
    const selectedWeeklyCells = new Set();
    let weeklyDragging = false;
    const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const planClock = el('#plan-clock');
    const todayPlanDate = el('#today-plan-date');
    const todayPlanList = el('#today-plan-list');
    const todoReminderList = el('#todo-reminder-list');
    const eventPlanList = el('#event-plan-list');
    const weeklyGrid = el('#weekly-grid');
    const weeklySelectionCount = el('#weekly-selection-count');
    const weeklyStatus = el('#weekly-status');
    const planDataStatus = el('#plan-data-status');
    const planArchiveCount = el('#plan-archive-count');
    const todayArchiveList = el('#today-archive-list');
    const eventArchiveList = el('#event-archive-list');
    const formatPlanDateTime = (value) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value || '');
      return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    };
    const formatTodayDate = (key) => {
      const date = new Date(`${key}T12:00:00`);
      return Number.isNaN(date.getTime()) ? key : date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
    };
    function updatePlanClock() {
      if (planClock) planClock.textContent = new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    function createPlanEmpty(text) {
      const empty = document.createElement('div');
      empty.className = 'plan-empty';
      empty.textContent = text;
      return empty;
    }
    function renderTodayPlans() {
      if (!todayPlanList || !plans?.today) return;
      todayPlanList.innerHTML = '';
      if (todayPlanDate) todayPlanDate.textContent = formatTodayDate(plans.today.bucketDate);
      const items = [...plans.today.items].sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? 1 : -1;
        return String(a.startTime || '').localeCompare(String(b.startTime || ''));
      });
      if (!items.length) { todayPlanList.append(createPlanEmpty('今天还没有安排，先写下一件想完成的事吧。')); return; }
      items.forEach((item) => {
        const row = document.createElement('article');
        row.className = `plan-item ${item.allDay ? 'todo-item' : 'scheduled-item'}${item.done ? ' done' : ''}`;
        const main = document.createElement(item.allDay ? 'button' : 'div');
        main.className = `plan-item-main${item.allDay ? ' plan-item-toggle' : ''}`;
        if (item.allDay) {
          main.type = 'button';
          main.ariaPressed = String(item.done);
          main.ariaLabel = `${item.done ? '标记待办未完成' : '标记待办完成'}：${item.title}`;
          main.addEventListener('click', async () => { plans = await api.markTodayDone(item.id, !item.done); renderPlans(plans); });
        }
        const title = document.createElement('div'); title.className = 'plan-item-title'; title.textContent = item.title;
        const time = document.createElement('div'); time.className = 'plan-item-time'; time.textContent = item.allDay ? '无时间限制 · 待办 · 点击标签切换完成' : `${item.startTime || '--:--'}${item.endTime ? ` – ${item.endTime}` : ''}`;
        main.append(title, time);
        if (!item.allDay) {
          const status = document.createElement('div'); status.className = 'plan-item-status'; status.textContent = item.done ? '已自动完成' : '到时间自动完成';
          main.append(status);
        }
        const actions = document.createElement('div'); actions.className = 'plan-item-actions';
        const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '编辑';
        edit.addEventListener('click', async () => {
          const nextTitle = window.prompt('修改计划名称', item.title);
          if (!nextTitle?.trim()) return;
          plans = await api.updateTodayPlan(item.id, { title: nextTitle.trim() }); renderPlans(plans);
        });
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除';
        remove.addEventListener('click', async () => { plans = await api.deleteTodayPlan(item.id); renderPlans(plans); });
        actions.append(edit, remove); row.append(main, actions); todayPlanList.append(row);
      });
    }
    function renderTodoReminderTimes() {
      if (!todoReminderList) return;
      todoReminderList.innerHTML = '';
      (plans?.todoReminderTimes || []).forEach((time) => {
        const tag = document.createElement('span'); tag.className = 'time-tag'; tag.textContent = time;
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.ariaLabel = `删除 ${time}`;
        remove.addEventListener('click', async () => { plans = await api.saveTodoReminderTimes((plans.todoReminderTimes || []).filter((value) => value !== time)); renderPlans(plans); });
        tag.append(remove); todoReminderList.append(tag);
      });
    }
    function renderEvents() {
      if (!eventPlanList) return;
      eventPlanList.innerHTML = '';
      const items = [...(plans?.events || [])].sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
      if (!items.length) { eventPlanList.append(createPlanEmpty('还没有日程。')); return; }
      items.forEach((item) => {
        const row = document.createElement('article'); row.className = `plan-item scheduled-item${item.done ? ' done' : ''}`;
        const main = document.createElement('div'); main.className = 'plan-item-main';
        const title = document.createElement('div'); title.className = 'plan-item-title'; title.textContent = item.title;
        const time = document.createElement('div'); time.className = 'plan-item-time'; time.textContent = `${formatPlanDateTime(item.startAt)}${item.endAt ? ` – ${formatPlanDateTime(item.endAt)}` : ''}`;
        const status = document.createElement('div'); status.className = 'plan-item-status'; status.textContent = item.done ? '已自动完成' : '到时间自动完成';
        main.append(title, time, status);
        const actions = document.createElement('div'); actions.className = 'plan-item-actions';
        const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '编辑';
        edit.addEventListener('click', async () => {
          const nextTitle = window.prompt('修改日程名称', item.title);
          if (!nextTitle?.trim()) return;
          plans = await api.updatePlanEvent(item.id, { title: nextTitle.trim() }); renderPlans(plans);
        });
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除';
        remove.addEventListener('click', async () => { plans = await api.deletePlanEvent(item.id); renderPlans(plans); });
        actions.append(edit, remove); row.append(main, actions); eventPlanList.append(row);
      });
    }
    function renderPlanArchives() {
      const todayArchives = Array.isArray(plans?.todayArchive) ? plans.todayArchive : [];
      const eventArchives = Array.isArray(plans?.eventArchive) ? plans.eventArchive : [];
      if (planArchiveCount) planArchiveCount.textContent = String(todayArchives.length + eventArchives.length);
      if (todayArchiveList) {
        todayArchiveList.innerHTML = '';
        if (!todayArchives.length) todayArchiveList.append(createPlanEmpty('暂无归档'));
        todayArchives.slice().reverse().forEach((archive) => {
          const item = document.createElement('div'); item.className = 'archive-item';
          item.textContent = archive.date || '未命名日期';
          const detail = document.createElement('small'); detail.textContent = (archive.items || []).map((entry) => entry.title).join('、') || '无条目'; item.append(detail); todayArchiveList.append(item);
        });
      }
      if (eventArchiveList) {
        eventArchiveList.innerHTML = '';
        if (!eventArchives.length) eventArchiveList.append(createPlanEmpty('暂无归档'));
        eventArchives.slice().reverse().forEach((archive) => {
          const event = archive.event || {}; const item = document.createElement('div'); item.className = 'archive-item'; item.textContent = event.title || '未命名日程';
          const detail = document.createElement('small'); detail.textContent = formatPlanDateTime(event.startAt); item.append(detail); eventArchiveList.append(item);
        });
      }
    }
    function weeklyCellKey(day, start) { return `${day}|${start}`; }
    function addMinutesToTime(time, minutes) {
      const [hour, minute] = time.split(':').map(Number); const total = hour * 60 + minute + minutes;
      return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }
    function updateWeeklySelectionUi() {
      if (weeklySelectionCount) weeklySelectionCount.textContent = selectedWeeklyCells.size ? `已选择 ${selectedWeeklyCells.size} 个时间格` : '尚未选择时间格';
      weeklyGrid?.querySelectorAll('.week-cell').forEach((cell) => cell.classList.toggle('selected', selectedWeeklyCells.has(cell.dataset.key)));
    }
    function normalizeWeeklyDuration(value) { return Math.min(240, Math.max(5, Math.round(Number(value) || 45))); }
    function normalizeWeeklyRows(value) { return Math.min(40, Math.max(1, Math.round(Number(value) || 13))); }
    function defaultWeeklyTime(index, duration) {
      const total = 8 * 60 + index * duration;
      return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }
    function weeklySettingsSnapshot() {
      const rowCount = normalizeWeeklyRows(el('#weekly-row-count')?.value || plans?.weekly?.rowCount || 13);
      const duration = normalizeWeeklyDuration(el('#weekly-duration')?.value || plans?.weekly?.durationMinutes || 45);
      const rowInputs = weeklyGrid?.querySelectorAll('.weekly-row-time') || [];
      const oldTimes = Array.isArray(plans?.weekly?.rowTimes) ? plans.weekly.rowTimes : [];
      const rowTimes = Array.from({ length: rowCount }, (_item, index) => {
        const input = rowInputs[index];
        return input?.value || oldTimes[index] || defaultWeeklyTime(index, duration);
      });
      return { rowCount, durationMinutes: duration, rowTimes };
    }
    function renderWeeklyGrid() {
      if (!weeklyGrid) return;
      const rowCount = normalizeWeeklyRows(plans?.weekly?.rowCount || el('#weekly-row-count')?.value || 13);
      const duration = normalizeWeeklyDuration(plans?.weekly?.durationMinutes || el('#weekly-duration')?.value || 45);
      if (el('#weekly-row-count')) el('#weekly-row-count').value = rowCount;
      if (el('#weekly-duration')) el('#weekly-duration').value = duration;
      const rowTimes = Array.isArray(plans?.weekly?.rowTimes) ? plans.weekly.rowTimes : [];
      const existing = new Map((plans?.weekly?.slots || []).map((slot) => [weeklyCellKey(slot.day, slot.start), slot]));
      weeklyGrid.innerHTML = '';
      const table = document.createElement('table'); table.className = 'weekly-table';
      const head = document.createElement('thead'); const headRow = document.createElement('tr');
      const blank = document.createElement('th'); blank.textContent = '时间'; headRow.append(blank);
      weekdayNames.forEach((name) => { const th = document.createElement('th'); th.textContent = name; headRow.append(th); }); head.append(headRow); table.append(head);
      const body = document.createElement('tbody');
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const start = rowTimes[rowIndex] || defaultWeeklyTime(rowIndex, duration);
        const row = document.createElement('tr'); const time = document.createElement('td'); time.className = 'weekly-time';
        const timeInput = document.createElement('input'); timeInput.className = 'weekly-row-time'; timeInput.type = 'time'; timeInput.value = start; timeInput.ariaLabel = `第 ${rowIndex + 1} 行时间`;
        timeInput.addEventListener('change', async () => {
          const settings = weeklySettingsSnapshot();
          settings.rowTimes[rowIndex] = timeInput.value || defaultWeeklyTime(rowIndex, settings.durationMinutes);
          try { plans = await api.saveWeeklySettings(settings); renderPlans(plans); if (weeklyStatus) weeklyStatus.textContent = '已保存行表头时间。'; } catch (error) { if (weeklyStatus) weeklyStatus.textContent = `保存行表头失败：${error.message}`; }
        });
        time.append(timeInput); row.append(time);
        for (let day = 0; day < 7; day += 1) {
          const key = weeklyCellKey(day, start); const cell = document.createElement('td'); cell.className = 'week-cell'; cell.dataset.key = key; cell.dataset.day = String(day); cell.dataset.start = start;
          const slot = existing.get(key); if (slot) { cell.classList.add('has-plan'); const text = document.createElement('span'); text.className = 'week-cell-title'; text.textContent = slot.title; cell.append(text); }
          cell.addEventListener('pointerdown', (event) => { if (event.button !== 0) return; event.preventDefault(); weeklyDragging = true; selectedWeeklyCells.clear(); selectedWeeklyCells.add(key); updateWeeklySelectionUi(); });
          cell.addEventListener('pointerenter', () => { if (!weeklyDragging) return; selectedWeeklyCells.add(key); updateWeeklySelectionUi(); });
          row.append(cell);
        }
        body.append(row);
      }
      table.append(body); weeklyGrid.append(table); updateWeeklySelectionUi();
    }
    function renderPlans(snapshot) {
      plans = snapshot || plans; if (!plans) return;
      renderTodayPlans(); renderTodoReminderTimes(); renderEvents(); renderWeeklyGrid(); renderPlanArchives(); updatePlanClock();
    }
    window.addEventListener('pointerup', () => { weeklyDragging = false; });
    api.onPlansChanged((snapshot) => renderPlans(snapshot));
    el('#plan-clock')?.addEventListener('click', updatePlanClock);
    document.querySelectorAll('.plan-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const viewName = tab.dataset.planView;
        document.querySelectorAll('.plan-tab').forEach((item) => { const active = item === tab; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); });
        document.querySelectorAll('.plan-view').forEach((panel) => { const active = panel.id === `plan-view-${viewName}`; panel.classList.toggle('active', active); panel.hidden = !active; });
      });
    });
    el('#today-plan-all-day')?.addEventListener('change', (event) => { ['#today-plan-start', '#today-plan-end'].forEach((selector) => { const input = el(selector); input.disabled = event.target.checked; if (event.target.checked) input.value = ''; }); });
    el('#today-plan-form')?.addEventListener('submit', async (event) => {
      event.preventDefault(); const title = el('#today-plan-title').value.trim(); if (!title) return;
      try { plans = await api.addTodayPlan({ title, startTime: el('#today-plan-start').value, endTime: el('#today-plan-end').value, allDay: el('#today-plan-all-day').checked }); event.target.reset(); ['#today-plan-start', '#today-plan-end'].forEach((selector) => { el(selector).disabled = false; }); renderPlans(plans); }
      catch (error) { window.alert(`添加今日安排失败：${error.message}`); }
    });
    el('#todo-reminder-form')?.addEventListener('submit', async (event) => {
      event.preventDefault(); const time = el('#todo-reminder-time').value; if (!time) return;
      try { plans = await api.saveTodoReminderTimes([...(plans?.todoReminderTimes || []), time]); renderPlans(plans); } catch (error) { window.alert(`保存提醒时间失败：${error.message}`); }
    });
    const saveWeeklyTableSettings = async () => {
      const settings = weeklySettingsSnapshot();
      if (el('#weekly-row-count')) el('#weekly-row-count').value = settings.rowCount;
      if (el('#weekly-duration')) el('#weekly-duration').value = settings.durationMinutes;
      try { plans = await api.saveWeeklySettings(settings); selectedWeeklyCells.clear(); renderPlans(plans); if (weeklyStatus) weeklyStatus.textContent = `已保存表格设置：${settings.rowCount} 行，每行 ${settings.durationMinutes} 分钟。`; }
      catch (error) { if (weeklyStatus) weeklyStatus.textContent = `保存表格设置失败：${error.message}`; }
    };
    el('#weekly-settings-save')?.addEventListener('click', saveWeeklyTableSettings);
    el('#weekly-row-count')?.addEventListener('change', saveWeeklyTableSettings);
    el('#weekly-duration')?.addEventListener('change', saveWeeklyTableSettings);
    el('#weekly-save')?.addEventListener('click', async () => {
      const title = el('#weekly-plan-title').value.trim(); if (!selectedWeeklyCells.size || !title) { if (weeklyStatus) weeklyStatus.textContent = '请先选择时间格并填写计划名称。'; return; }
      const duration = normalizeWeeklyDuration(el('#weekly-duration').value);
      const slots = [...selectedWeeklyCells].map((key) => { const [day, start] = key.split('|'); return { day: Number(day), start, end: addMinutesToTime(start, duration), title }; });
      try { plans = await api.upsertWeeklySlots(slots, duration); el('#weekly-plan-title').value = ''; selectedWeeklyCells.clear(); renderPlans(plans); if (weeklyStatus) weeklyStatus.textContent = '已保存每周重复计划。'; } catch (error) { if (weeklyStatus) weeklyStatus.textContent = `保存失败：${error.message}`; }
    });
    el('#weekly-clear')?.addEventListener('click', async () => {
      if (!selectedWeeklyCells.size) return; const duration = normalizeWeeklyDuration(el('#weekly-duration').value); const slots = [...selectedWeeklyCells].map((key) => { const [day, start] = key.split('|'); return { day: Number(day), start, end: addMinutesToTime(start, duration), title: '' }; });
      try { plans = await api.upsertWeeklySlots(slots, duration); selectedWeeklyCells.clear(); renderPlans(plans); if (weeklyStatus) weeklyStatus.textContent = '已清除选中时间格。'; } catch (error) { if (weeklyStatus) weeklyStatus.textContent = `清除失败：${error.message}`; }
    });
    el('#event-plan-form')?.addEventListener('submit', async (event) => {
      event.preventDefault(); const title = el('#event-plan-title').value.trim(); const startAt = el('#event-plan-start').value; if (!title || !startAt) return;
      try { plans = await api.addPlanEvent({ title, startAt, endAt: el('#event-plan-end').value }); event.target.reset(); renderPlans(plans); } catch (error) { window.alert(`添加日程失败：${error.message}`); }
    });
    el('#export-plans')?.addEventListener('click', async () => { try { const result = await api.exportPlans(); if (planDataStatus) planDataStatus.textContent = result.exported ? `计划数据已导出：${result.path}` : '已取消导出。'; } catch (error) { if (planDataStatus) planDataStatus.textContent = `导出失败：${error.message}`; } });
    el('#delete-all-plans')?.addEventListener('click', async () => { if (!window.confirm('确定清空当前计划吗？已归档历史不会被删除。')) return; try { plans = await api.deleteAllPlans(); renderPlans(plans); if (planDataStatus) planDataStatus.textContent = '当前计划已清空。'; } catch (error) { if (planDataStatus) planDataStatus.textContent = `清空失败：${error.message}`; } });
    el('#delete-all-plan-data')?.addEventListener('click', async () => { if (!window.confirm('确定删除全部计划数据吗？当前计划和归档都将永久删除。')) return; try { plans = await api.deleteAllPlans(true); renderPlans(plans); if (planDataStatus) planDataStatus.textContent = '全部计划数据已删除。'; } catch (error) { if (planDataStatus) planDataStatus.textContent = `删除失败：${error.message}`; } });
    setInterval(updatePlanClock, 30000);

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

    function applyAvatarElement(element) {
      if (!element) return;
      const image = element.querySelector('.avatar-image');
      const url = config?.persona?.avatar?.url || '';
      if (image) {
        if (url) {
          if (image.getAttribute('src') !== url) image.src = url;
          image.hidden = false;
        } else {
          image.removeAttribute('src');
          image.hidden = true;
        }
      }
      element.classList.toggle('has-avatar', Boolean(url));
    }

    function refreshAvatars() {
      messages.querySelectorAll('.avatar').forEach(applyAvatarElement);
    }

    function renderPersonaAvatarPreview() {
      const preview = el('#persona-avatar-preview');
      const image = el('#persona-avatar-preview-image');
      const empty = el('#persona-avatar-preview-empty');
      const url = config?.persona?.avatar?.url || '';
      if (!preview || !image || !empty) return;
      if (url) {
        image.src = url;
        image.hidden = false;
        empty.hidden = true;
      } else {
        image.removeAttribute('src');
        image.hidden = true;
        empty.hidden = false;
      }
      preview.classList.toggle('has-avatar', Boolean(url));
    }

    function applyConfig(next) {
      config = next;
      const skin = ['classic', 'refined', 'reference', 'pepe'].includes(config.ui?.skin) ? config.ui.skin : 'classic';
      document.documentElement.dataset.skin = skin;
      el('#chat-name').textContent = config.persona.name;
      el('#persona-name').value = config.persona.name;
      renderPersonaAvatarPreview();
      refreshAvatars();
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
      const updateSource = config.update?.source === 'mirror' ? 'mirror' : 'github';
      document.querySelectorAll('input[name="update-source"]').forEach((input) => {
        input.checked = input.value === updateSource;
      });
      el('#mirror-resource-id').value = config.update?.mirrorResourceId || '';
      el('#mirror-cdk').value = '';
      el('#mirror-cdk-state').textContent = config.update?.mirrorCdkSet
        ? 'Mirror酱 CDK 已保存（为安全起见不回显）'
        : 'Mirror酱 CDK 尚未保存';
      el('#text-key-state').textContent = config.api.textApiKeySet ? '文本 API Key 已保存（为安全起见不回显）' : '文本 API Key 尚未保存';
      el('#vision-key-state').textContent = config.api.visionApiKeySet ? '视觉 API Key 已保存（为安全起见不回显）' : '视觉 API Key 尚未保存';
      el('#automation-enabled').checked = config.automation.enabled;
      el('#automation-auto-execute').checked = config.automation.autoExecute === true;
      el('#automation-start-at-login').checked = config.automation.startAtLogin === true;
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

    function removeRenderedPair(target) {
      const row = target?.closest?.('.message') || target;
      if (!row || !row.isConnected) return;
      let next = row.nextElementSibling;
      row.remove();
      while (next) {
        const candidate = next;
        next = candidate.nextElementSibling;
        if (candidate.dataset.persisted === 'true') {
          if (candidate.classList.contains('assistant')) candidate.remove();
          break;
        }
      }
    }

    async function syncHistoryIndexes() {
      try {
        const history = await api.getChatHistory();
        const entries = Array.isArray(history) ? history : [];
        const nodes = [...messages.children].filter((row) => row.dataset.persisted === 'true');
        nextHistoryIndex = 0;
        entries.forEach((entry, index) => {
          const row = nodes[index];
          if (!row) return;
          const historyIndex = Number.isInteger(Number(entry.historyIndex)) ? Number(entry.historyIndex) : index;
          row.dataset.historyIndex = String(historyIndex);
          row.querySelector('.bubble')?.setAttribute('data-history-index', String(historyIndex));
          nextHistoryIndex = Math.max(nextHistoryIndex, historyIndex + 1);
        });
      } catch { /* best effort; the active transcript remains usable. */ }
    }

    function addMessage(role, text, options = {}) {
      const row = document.createElement('div');
      row.className = `message ${role}`;
      const persisted = options.persisted !== false && ['user', 'assistant'].includes(role);
      if (persisted) {
        const suppliedIndex = Number(options.historyIndex);
        const historyIndex = Number.isInteger(suppliedIndex) && suppliedIndex >= 0 ? suppliedIndex : nextHistoryIndex;
        row.dataset.persisted = 'true';
        row.dataset.historyIndex = String(historyIndex);
        nextHistoryIndex = Math.max(nextHistoryIndex, historyIndex + 1);
      } else {
        row.dataset.persisted = 'false';
      }
      if (role === 'assistant') {
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.innerHTML = '<img class="avatar-image" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="" hidden /><span class="avatar-glyph">✦</span><svg class="avatar-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 14.4 9l5.9 1-4.4 4.1 1 5.9-4.9-2.8-4.9 2.8 1-5.9-4.4-4.1 5.9-1L12 3.5Z"/></svg>';
        applyAvatarElement(avatar);
        row.append(avatar);
      }
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      const messageText = String(text || '');
      bubble.textContent = messageText;
      if (persisted) bubble.dataset.historyIndex = row.dataset.historyIndex;
      if (role === 'user') {
        bubble.classList.add('editable-user-message');
        bubble.title = '右键选择修改或删除';
        bubble.addEventListener('contextmenu', (event) => {
          const historyIndex = Number(bubble.dataset.historyIndex);
          if (!Number.isInteger(historyIndex)) return;
          openMessageContextMenu(event, bubble, {
            onEdit: () => {
              if (sending) return;
              editingMessage?.element?.classList.remove('editing-message');
              editingMessage = { historyIndex, element: bubble };
              bubble.classList.add('editing-message');
              refillInput(messageText);
            },
            onDelete: async () => {
              if (sending) return;
              editingMessage = undefined;
              try {
                const history = await api.removeChatMessage(historyIndex);
                replaceHistory(history);
              } catch (error) {
                addMessage('error', `删除消息失败：${error.message}`, { persisted: false });
              }
            }
          });
        });
      }
      row.append(bubble);
      messages.append(row);
      scrollMessages();
      return row;
    }

    function showThinking() {
      thinkingCount += 1;
      if (thinkingItem) return;
      initialGreetingRow.hidden = true;
      thinkingItem = addMessage('assistant', '', { persisted: false });
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
        if (message?.role === 'user' || message?.role === 'assistant') {
          addMessage(message.role, message.content || '', { historyIndex: message.historyIndex });
        }
      });
    }

    function replaceHistory(history) {
      if (!historyReady) {
        pendingHistory = Array.isArray(history) ? history : [];
        return;
      }
      const wasThinking = Boolean(thinkingItem);
      historyRevision += 1;
      nextHistoryIndex = 0;
      editingMessage = undefined;
      closeMessageContextMenu();
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
      const editTarget = editingMessage;
      editingMessage = undefined;
      editTarget?.element?.classList.remove('editing-message');
      sending = true;
      input.value = '';
      input.style.height = 'auto';
      el('#send').disabled = true;
      if (editTarget) removeRenderedPair(editTarget.element);
      addMessage('user', text);
      showThinking();
      try {
        const answer = editTarget
          ? await api.chat(text, { editHistoryIndex: editTarget.historyIndex })
          : await api.chat(text);
        if (answer.content) addMessage('assistant', answer.content);
        if (!answer.content && (!answer.actions || answer.actions.length === 0)) addMessage('assistant', '我暂时没有得到可显示的回复。', { persisted: false });
        if (answer.actions?.length) addMessage('assistant', '确认弹窗已打开，请在弹窗中选择是否执行。', { persisted: false });
        if (editTarget) await syncHistoryIndexes();
      } catch (error) {
        addMessage('assistant', `抱歉，无法完成这次请求：${error.message}`, { persisted: false });
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
        update: {
          repository: el('#update-repository').value,
          source: document.querySelector('input[name="update-source"]:checked')?.value || 'github',
          mirrorResourceId: el('#mirror-resource-id').value,
          mirrorCdk: el('#mirror-cdk').value
        }
      });
      el('#api-text-key').value = '';
      el('#api-vision-key').value = '';
      el('#mirror-cdk').value = '';
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

    async function choosePersonaAvatar() {
      const status = el('#persona-import-status');
      status.textContent = '正在选择聊天头像…';
      try {
        const next = await api.choosePersonaAvatar();
        applyConfig(next);
        status.textContent = next.persona?.avatar?.url ? '聊天头像已更新。' : '已取消选择。';
      } catch (error) {
        status.textContent = `头像导入失败：${error.message}`;
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
      nextHistoryIndex = 0;
      editingMessage = undefined;
      closeMessageContextMenu();
      addMessage('assistant', '本次对话已清空。我们重新开始吧。', { persisted: false });
    });
    document.querySelector('[data-save="persona"]').addEventListener('click', savePersona);
    el('#choose-persona-avatar').addEventListener('click', choosePersonaAvatar);
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
      const selectedSource = document.querySelector('input[name="update-source"]:checked')?.value || 'github';
      const sourceLabel = selectedSource === 'mirror' ? 'Mirror酱' : 'GitHub';
      status.textContent = `正在检查 ${sourceLabel} 更新…`;
      try {
        const result = await api.checkForUpdates();
        if (!result.configured) {
          status.textContent = '请先填写更新仓库，例如 your-name/listagent。';
        } else if (!result.updateAvailable) {
          status.textContent = `当前已是最新版本 v${result.currentVersion}（${result.source === 'mirror' ? 'Mirror酱' : 'GitHub'}）。`;
        } else {
          const modeHint = result.mode === 'delta' ? '安装时只下载变化的程序文件' : result.source === 'mirror' ? '将从 Mirror酱下载完整便携包' : '该 Release 没有增量清单，将下载完整包';
          status.textContent = `发现新版本 v${result.latestVersion}（${result.source === 'mirror' ? 'Mirror酱' : 'GitHub'}），${modeHint}。点击“立即更新”。`;
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
      const selectedSource = document.querySelector('input[name="update-source"]:checked')?.value || 'github';
      status.textContent = selectedSource === 'mirror'
        ? '正在从 Mirror酱下载更新，完成后会自动重启…'
        : '正在获取更新清单并下载变化文件，完成后会自动重启…';
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
    el('#automation-start-at-login').addEventListener('change', async (event) => {
      const input = event.target;
      try {
        applyConfig(await api.saveConfig({ automation: { startAtLogin: input.checked } }));
      } catch (error) {
        input.checked = !input.checked;
        window.alert(`开机自启动设置失败：${error.message}`);
      }
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
    try { applyCompanionRecord(await api.getCompanionRecord()); } catch { /* metrics remain at zero if persistence is unavailable. */ }
    try { renderPlans(await api.getPlans()); } catch (error) { if (planDataStatus) planDataStatus.textContent = `计划读取失败：${error.message}`; }
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
        addMessage('assistant', greeting, { persisted: false });
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
