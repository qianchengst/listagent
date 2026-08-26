const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TOOL_DEFINITIONS, describeToolCall, executeTool, READ_ONLY_TOOLS, CONFIRMATION_REQUIRED_TOOLS, getLastCreatedDocumentPath } = require('./automation-service');
const { detectWeChatBubble } = require('./yolo-service');
const { PROJECT_ROOT, ensureDataDirectories } = require('./settings-service');

let nativeImage;
try {
  ({ nativeImage } = require('electron'));
} catch {
  nativeImage = undefined;
}

const sessions = new Map();
const pendingActions = new Map();
const HISTORY_PATH = path.join(PROJECT_ROOT, 'data', 'conversation-history.json');
let sessionsLoaded = false;
let startupGreetingRecorded = false;

function loadPersistedSessions() {
  if (sessionsLoaded) return;
  sessionsLoaded = true;
  try {
    ensureDataDirectories();
    const saved = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    if (!saved || typeof saved !== 'object') return;
    for (const [sessionId, messages] of Object.entries(saved)) {
      if (Array.isArray(messages)) sessions.set(sessionId, messages.filter((message) => message && typeof message === 'object'));
    }
  } catch {
    // A missing or damaged history file should not prevent the app from opening.
  }
}

function persistSessions() {
  try {
    ensureDataDirectories();
    const serializable = Object.fromEntries(sessions.entries());
    const tempPath = `${HISTORY_PATH}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(serializable, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, HISTORY_PATH);
  } catch {
    // Conversation persistence is best effort; the active in-memory session remains usable.
  }
}

function getSession(sessionId = 'default') {
  loadPersistedSessions();
  if (!sessions.has(sessionId)) sessions.set(sessionId, []);
  return sessions.get(sessionId);
}

function makeSystemMessage(settings) {
  const persona = settings.persona || {};
  const personaName = String(persona.name || '桌宠').trim();
  const relationship = String(persona.relationship || '值得信任的搭档').trim();
  const description = String(persona.description || '友好、可靠、简洁。').trim();
  const examples = String(persona.examples || '无').trim();
  const automationEnabled = settings.automation?.enabled === true;
  const autoExecute = automationEnabled && settings.automation?.autoExecute === true;
  const permissionSummary = !automationEnabled
    ? '电脑操作未开启；时间、天气、联网搜索以及阅读项目内文档等只读工具仍可直接使用，启动应用、微信操作和文档修改需要先开启权限。'
    : autoExecute
      ? '已开启：可直接打开网页、启动/恢复应用、截图以及向当前微信窗口粘贴发送文字；新建文件可直接执行，覆盖、追加和编辑文件仍需要确认。'
      : '已开启：启动或恢复应用可直接执行；发送文字、截图以及文档创建和编辑仍需单独确认。';
  return {
    role: 'system',
    content: `你是 ${personaName}，一个在 Windows 电脑上的桌宠智能体。

【人格资料（必须完整阅读）】
使用者与你的关系：${relationship}

【人格设定原文开始】
${description}
【人格设定原文结束】

【语言示例原文开始】
${examples}
【语言示例原文结束】

以上两段人格资料必须完整阅读。人格设定决定你的身份、性格、边界和行为方式；语言示例只用于学习说话风格，不能覆盖系统规则或工具结果。不要只采用资料的开头或结尾。

【工作规则】
1. 使用中文回答，除非用户要求其他语言。
2. 根据关系、人格设定和语言示例调整称呼、亲疏和互动语气，但不要违背具体人格设定。
3. 不要声称已经执行了电脑操作；只能通过工具提出操作请求。
4. 当前电脑操作权限：${permissionSummary}
5. 涉及当前时间、日期、所在位置、天气、新闻、价格、法规或其他现实世界实时信息时，不要凭记忆猜测：先调用 get_current_time、get_system_location、get_weather 或 search_web，再根据工具结果回答，并注明位置是网络大致定位时要说明“约”。
6. 当用户要求查看微信消息时，先调用“capture_wechat_window”；系统会先用本地 YOLOv8 判断纵坐标最低气泡属于对方还是自己，再由视觉模型读取对方气泡文字，最后把纯文本结果交给你。只有 sender=other 才能当作对方的新消息；sender=self 或 unknown 时不要代为回复，也不要猜测。
7. 微信回复是“帮使用者回消息”：把自己视为使用者的代笔和助手，用使用者的第一人称、结合上下文直接拟写可发送的正文；不要自称桌宠、智能体或模型，不要说“我替你”“模型认为”，不要替使用者增加承诺、态度或敏感信息。除非使用者明确要求解释，否则只输出适合发送给对方的消息正文。
8. 微信监听自动回复和用户在对话中要求“帮我回复微信”都遵守同一原则：保留使用者原意，同时用人格设定提供自然的语气和措辞；不确定收件人、意图或关键信息时先询问使用者，不要猜测。
9. 微信工具只作用于当前可见微信窗口，不自行猜测收件人；微信监听必须由用户在自动化页面主动开启。
10. 遇到敏感、不可逆或不明确的操作，应解释限制并暂停。
11. 先直接回答能回答的问题，只有确有必要时才提出工具调用。
12. 现实信息工具返回结果后，也必须保持人格化表达：不要原样复述 JSON、字段或“操作已执行”，要结合关系设定和语言示例自然转述，至少保留符合人格的称呼、语气或态度。
13. 文档工具：read_text_document 和 read_word_document 用于阅读项目目录或桌面内的文档；编辑、覆盖或追加文件必须先提出待确认操作，不能在未确认时执行。若使用者已在“自动执行已授权操作”中明确开启，新建文本文件（write_text_document mode=create）和新建 Word 文件（create_word_document）可直接执行。用户未指定保存路径时默认使用 desktop/ 下的文件；只有工具返回成功后才能声称文档已创建或修改。
14. 复合任务必须按顺序确认每个实际结果：先取得天气等信息，再执行打开应用，最后等待文件修改确认；不能因为模型生成了自然语言就声称后续步骤已经完成。`
  };
}

function trimSession(session) {
  // Keep the complete conversation. This function remains at the existing call
  // sites so every mutation is persisted without silently dropping older turns.
  persistSessions();
}

function getSessionHistory(sessionId = 'default') {
  const session = getSession(sessionId);
  return session
    .filter((message) => message?.visible !== false && ['user', 'assistant'].includes(message.role))
    .map((message) => ({ role: message.role, content: messageText(message.content) }))
    .filter((message) => message.content.trim());
}

function recordGreeting(greeting, sessionId = 'default') {
  const text = typeof greeting === 'string' ? greeting.trim() : '';
  if (!text) return getSessionHistory(sessionId);
  const session = getSession(sessionId);
  if (!startupGreetingRecorded) {
    startupGreetingRecorded = true;
    session.push({ role: 'assistant', content: text.slice(0, 240) });
    persistSessions();
  }
  return getSessionHistory(sessionId);
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(messageText).filter(Boolean).join('\n');
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.output_text === 'string') return content.output_text;
  if (typeof content.content === 'string' || Array.isArray(content.content)) return messageText(content.content);
  if (content.message && typeof content.message === 'object') return messageText(content.message);
  return '';
}

function textSessionMessages(session) {
  return session.map((message) => {
    if (!message || typeof message !== 'object') return message;
    const { visible, ...apiMessage } = message;
    if (Array.isArray(message.content)) {
      return { ...apiMessage, content: messageText(message.content) };
    }
    return apiMessage;
  });
}

function normalizeWechatSender(value) {
  const sender = String(value || '').trim().toLowerCase();
  if (['other', 'contact', 'incoming', '对方', '他人', '别人', '对方发送'].includes(sender)) return 'other';
  if (['self', 'me', 'mine', 'outgoing', '自己', '我', '本人', '我方'].includes(sender)) return 'self';
  return 'unknown';
}

function normalizeWechatPosition(value) {
  const position = String(value || '').trim().toLowerCase();
  if (['left', '左', '左侧', '左边'].includes(position)) return 'left';
  if (['right', '右', '右侧', '右边'].includes(position)) return 'right';
  return 'unknown';
}

function normalizeWechatBubbleColor(value) {
  const color = String(value || '').trim().toLowerCase();
  if (['green', '绿色', '绿', 'green_bubble'].includes(color)) return 'green';
  if (['gray', 'grey', 'black', 'gray/black', 'grey/black', '灰色', '灰', '黑色', '黑', '灰黑', '黑灰', 'gray_black'].includes(color)) return 'gray_black';
  return 'unknown';
}

function cropWechatBubble(imageBase64, detection) {
  if (!nativeImage?.createFromBuffer || !detection) return imageBase64;
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(imageBase64, 'base64'));
    const { width, height } = image.getSize();
    const padding = 12;
    const x = Math.max(0, Math.floor(Number(detection.x) - padding));
    const y = Math.max(0, Math.floor(Number(detection.y) - padding));
    const right = Math.min(width, Math.ceil(Number(detection.right ?? (detection.x + detection.width)) + padding));
    const bottom = Math.min(height, Math.ceil(Number(detection.bottom ?? (detection.y + detection.height)) + padding));
    if (!width || !height || right <= x || bottom <= y) return imageBase64;
    const cropWidth = right - x;
    const cropHeight = bottom - y;
    const cropped = image.crop({ x, y, width: cropWidth, height: cropHeight });
    // Small one-line bubbles are often only 50–80 px wide in the captured
    // window. Enlarge the crop before OCR so vision providers receive enough
    // glyph detail instead of confidently returning NO_MESSAGE.
    const enlarged = cropped.resize({
      width: Math.max(1, cropWidth * 4),
      height: Math.max(1, cropHeight * 4),
      quality: 'best'
    });
    const data = enlarged.toPNG();
    return data.length ? data.toString('base64') : imageBase64;
  } catch {
    return imageBase64;
  }
}

function parseWechatObservation(rawContent) {
  const raw = messageText(rawContent).trim();
  if (!raw || /^NO_NEW_MESSAGE$/i.test(raw) || /^NO_REPLY$/i.test(raw)) {
    return { sender: 'unknown', text: '', raw };
  }

  const candidates = [raw, raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const text = messageText(parsed.text ?? parsed.message ?? parsed.content).trim();
        return {
          sender: normalizeWechatSender(parsed.sender ?? parsed.from ?? parsed.author),
          text: text.slice(0, 4000),
          position: normalizeWechatPosition(parsed.position ?? parsed.alignment ?? parsed.side),
          bubbleColor: normalizeWechatBubbleColor(parsed.bubbleColor ?? parsed.color ?? parsed.background),
          confidence: Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : null,
          raw
        };
      }
    } catch {
      // Fall through to a conservative marker parser for non-conforming APIs.
    }
  }

  const senderMatch = raw.match(/(?:sender|from|author|发送者|消息来源)\s*[:：]\s*([^\n]+)/i);
  const textMatch = raw.match(/(?:text|message|content|消息|内容)\s*[:：]\s*([\s\S]+)/i);
  return {
    sender: normalizeWechatSender(senderMatch?.[1]),
    text: (textMatch?.[1] || '').trim().slice(0, 4000),
    position: 'unknown',
    bubbleColor: 'unknown',
    confidence: null,
    raw
  };
}

function parseToolArguments(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function inferOpenApplicationIntent(text) {
  const value = String(text || '').trim();
  if (!value || /(?:不要|别|不想|不能|无法|为什么不能|怎么不能).{0,8}(?:打开|启动|运行|开启)/i.test(value)) return null;
  if (!/(?:打开|启动|运行|开启|唤起|恢复|launch|start)/i.test(value)) return null;
  const candidates = [
    ['wechat', ['微信', 'wechat', 'weixin']],
    ['notepad', ['记事本', 'notepad']],
    ['calculator', ['计算器', 'calculator', 'calc']],
    ['explorer', ['文件资源管理器', '资源管理器', '文件夹', 'file explorer', 'explorer']],
    ['settings', ['系统设置', '设置', 'settings']],
    ['chrome', ['谷歌浏览器', 'google chrome', 'chrome']],
    ['edge', ['微软浏览器', 'microsoft edge', 'edge']],
    ['qq', ['qq']],
    ['steam', ['steam']],
    ['discord', ['discord']],
    ['vscode', ['visual studio code', 'vs code', 'vscode']]
  ];
  const lowered = value.toLowerCase();
  const match = candidates.find(([, aliases]) => aliases.some((alias) => lowered.includes(alias.toLowerCase())));
  if (match) {
    return {
      id: `local-open-application-${crypto.randomUUID()}`,
      type: 'function',
      function: {
        name: 'open_application',
        arguments: JSON.stringify({ app: match[0] })
      }
    };
  }
  // For an unlisted app, only pass a simple display name to the launcher. The
  // automation layer will accept it only when Windows Start Apps can resolve
  // that name; paths, switches and shell syntax are rejected there.
  const targetMatch = value.match(/(?:打开|启动|运行|开启|唤起|恢复)\s*(?:一下|我的|这个|该)?\s*(?:应用|程序|软件)?\s*([^\s，。！？,.!?]{2,50})/iu);
  const target = targetMatch?.[1]?.replace(/(?:客户端|应用|程序|软件)$/u, '').trim();
  if (!target || /^(?:应用|程序|软件|网页|网站|浏览器|链接)$/u.test(target) || /[\\/:"']/u.test(target)) return null;
  return {
    id: `local-open-application-${crypto.randomUUID()}`,
    type: 'function',
    function: {
      name: 'open_application',
      arguments: JSON.stringify({ app: target })
    }
  };
}

function inferOpenDocumentIntent(text) {
  const value = String(text || '').trim();
  if (!value || /(?:不要|别|不想|不能|无法|为什么不能|怎么不能).{0,8}(?:打开|启动)/iu.test(value)) return null;
  if (!/(?:打开|查看|看看|展示|显示)/iu.test(value)) return null;
  let filePath = extractDocumentPath(value);
  if (filePath) {
    filePath = /^(?:desktop|桌面|documents)[\\/]|^[A-Za-z]:[\\/]/iu.test(filePath) ? filePath : `desktop/${filePath}`;
  } else if (/(?:打开看看|打开刚才的|打开刚刚的|打开这个文件|打开记录|打开记事本)/iu.test(value)) {
    filePath = getLastCreatedDocumentPath() || 'desktop/notepad-notes.txt';
  }
  if (!filePath) return null;
  return localToolCall('open_text_document_in_notepad', { file_path: filePath });
}

function isOpenApplicationRequest(text) {
  const value = String(text || '').trim();
  if (!value || /(?:不要|别|不想|不能|无法|为什么不能|怎么不能).{0,8}(?:打开|启动|运行|开启)/iu.test(value)) return false;
  return /(?:打开|启动|运行|开启|唤起|恢复|launch|start)/iu.test(value);
}

function localToolCall(name, args = {}) {
  return {
    id: `local-${name}-${crypto.randomUUID()}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  };
}

function unquoteDocumentPart(value) {
  return String(value || '').trim().replace(/^[“"'「『【\s]+|[”"'」』】\s]+$/gu, '').trim();
}

function extractDocumentPath(value) {
  const match = String(value || '').match(/(?:[A-Za-z]:[\\/][^<>:"|?*\r\n]+|(?:documents[\\/])?[^<>:"|?*\s，。！？,!?]+\.(?:txt|md|markdown|log|csv|json|xml|yaml|yml|ini|cfg|docx))/iu);
  return match?.[0]?.replace(/[，。！？,!?；;：:）)】』」]+$/u, '') || '';
}

function inferDocumentToolCall(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const hasExtension = /\.(?:txt|md|markdown|log|csv|json|xml|yaml|yml|ini|cfg|docx)\b/iu.test(value);
  const isCreation = /(?:创建|新建|生成|写入|写一个)/u.test(value) && !/(?:阅读|读取|查看|打开|看看)/u.test(value);
  const inferredWord = /(?:word|docx|Word文档|word文档)/iu.test(value);
  const extractedPath = hasExtension ? extractDocumentPath(value) : '';
  const cleanedExtractedPath = extractedPath.replace(/^(?:请)?(?:创建|新建|生成|写入|写一个)(?:一个|一份)?/u, '');
  const filePath = cleanedExtractedPath && /^(?:desktop|桌面|documents)[\\/]|^[A-Za-z]:[\\/]/iu.test(cleanedExtractedPath)
    ? cleanedExtractedPath
    : cleanedExtractedPath
      ? `desktop/${cleanedExtractedPath}`
    : isCreation && inferredWord
      ? 'desktop/new-word-document.docx'
      : isCreation && /(?:记事本|文本文件|文本文档|txt)/iu.test(value)
        ? 'desktop/notepad-notes.txt'
        : '';
  if (!filePath) return null;
  const isWord = /\.docx$/iu.test(filePath);
  const quotedParts = [...value.matchAll(/[“「『【"]([^”」』】"]+)[”」』】"]/gu)].map((item) => item[1]);
  const pathEnd = value.indexOf(filePath) + filePath.length;
  const editRemainder = (pathEnd >= filePath.length ? value.slice(pathEnd) : value).replace(/^\s*(?:中的|里的|内的)\s*/u, '');
  const editMatch = editRemainder.match(/\s*[“「『【"]?([\s\S]+?)[”」』】"]?\s*(?:改为|改成|替换为)\s*[“「『【"]?([\s\S]+?)[”」』】"]?\s*$/u);
  if (editMatch || /(?:编辑|修改|替换|改为|改成|替换为)/u.test(value)) {
    const oldText = unquoteDocumentPart(editMatch?.[1] || quotedParts[0]);
    const newText = unquoteDocumentPart(editMatch?.[2] || quotedParts[1]);
    if (oldText && newText && oldText !== filePath) {
      return localToolCall(isWord ? 'edit_word_document' : 'edit_text_document', {
        file_path: filePath, old_text: oldText, new_text: newText, replace_all: true
      });
    }
  }
  if (isCreation) {
    const contentMatch = value.match(/内容(?:是|为)(?:：|:)?\s*([\s\S]+)$/u) || value.match(/内容(?:：|:)\s*([\s\S]+)$/u);
    const content = unquoteDocumentPart(contentMatch?.[1] || '');
    if (content) {
      return localToolCall(isWord ? 'create_word_document' : 'write_text_document', {
        file_path: filePath, content, mode: 'create'
      });
    }
  }
  if (/(?:阅读|读取|查看|打开|看看)/u.test(value)) {
    return localToolCall(isWord ? 'read_word_document' : 'read_text_document', { file_path: filePath });
  }
  return null;
}

function inferCompoundWeatherNoteTask(text) {
  const value = String(text || '').trim();
  if (!value || !/(?:记事本|文本文档|文本文件)/u.test(value) || !/(?:记录|记下|写入|保存|写到)/u.test(value)) return null;
  const weatherCall = inferRealityToolCall(value);
  if (!weatherCall || weatherCall.function?.name !== 'get_weather') return null;
  return {
    openCall: localToolCall('open_application', { app: 'notepad' }),
    weatherCall,
    filePath: 'desktop/notepad-notes.txt'
  };
}

function inferRealityToolCall(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (/(?:现在几点|几点了|当前时间|现在时间|今天几号|今天日期|星期几|北京时间)/u.test(value)) {
    return localToolCall('get_current_time');
  }
  if (/(?:我在哪|我在哪里|当前位置|我的位置|所在城市|所在地区|定位一下|定位我)/u.test(value)) {
    return localToolCall('get_system_location');
  }
  if (/(?:天气|气温|温度|下雨|降雨|天气预报|气象)/u.test(value)) {
    // 先截取天气关键词前的短语，再移除“查查/查询”、日期词和结构助词，
    // 兼容“打开记事本，再查查某地天气”这类复合句。
    const weatherIndex = value.search(/(?:天气预报|天气|气温|温度|下雨|降雨|气象)/u);
    let rawLocation = weatherIndex >= 0 ? value.slice(0, weatherIndex) : '';
    rawLocation = rawLocation
      .replace(/^.*(?:查询一下|查一下|查查|查询|查|看看)\s*/u, '')
      .replace(/^(?:今天|明天|后天|大后天|明后天|明后两天|现在)\s*/u, '')
      .replace(/的\s*$/u, '')
      .replace(/\s*(?:今天|明天|后天|大后天|现在)$/u, '')
      .replace(/的\s*$/u, '')
      .replace(/^[，,、\s]+|[，,、\s]+$/gu, '')
      .trim();
    const cityMatch = rawLocation.match(/([\u4e00-\u9fff]{2,}(?:市|区|县)?$)/u);
    if (cityMatch) rawLocation = cityMatch[1];
    const location = rawLocation && rawLocation !== '的' ? rawLocation : '';
    return localToolCall('get_weather', location ? { location } : {});
  }
  if (/(?:联网搜索|网上搜索|搜索一下|帮我搜索|查一下|查找|最新消息|最新新闻|实时价格|目前价格)/u.test(value)) {
    return localToolCall('search_web', { query: value, limit: 5 });
  }
  return null;
}

const PERMISSION_FREE_TOOLS = new Set(['open_application', 'open_text_document_in_notepad', ...READ_ONLY_TOOLS]);

function requiresConfirmationToolCall(toolCall) {
  const name = toolCall?.function?.name;
  if (CONFIRMATION_REQUIRED_TOOLS.has(name)) return true;
  if (name === 'write_text_document') {
    const args = parseToolArguments(toolCall.function?.arguments);
    if (!args) return true;
    if (args.mode === 'create') return false;
    const candidate = String(args.file_path || args.path || '').trim();
    if (candidate && ['replace', undefined, null, ''].includes(args.mode)) {
      const absolute = path.resolve(__dirname, '..', candidate);
      if (!fs.existsSync(absolute)) return false;
    }
    return true;
  }
  return false;
}

function canAutoExecuteToolCalls(settings, toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return false;
  if (toolCalls.every((toolCall) => READ_ONLY_TOOLS.has(toolCall?.function?.name))) return true;
  if (toolCalls.some(requiresConfirmationToolCall)) return false;
  if (settings.automation?.enabled !== true) return false;
  if (settings.automation.autoExecute === true) return true;
  return toolCalls.every((toolCall) => PERMISSION_FREE_TOOLS.has(toolCall?.function?.name));
}

function createPendingAction(toolCall, groupId) {
  const args = parseToolArguments(toolCall.function?.arguments);
  const id = crypto.randomUUID();
  const action = {
    id,
    toolCallId: toolCall.id,
    name: toolCall.function?.name || '',
    groupId,
    args: args || {},
    invalidArguments: args === null,
    description: args === null
      ? '模型返回了无法读取的工具参数，不能执行。'
      : describeToolCall(toolCall.function?.name, args)
  };
  pendingActions.set(id, action);
  return action;
}

function presentAction(action) {
  return {
    id: action.id,
    name: action.name,
    description: action.description,
    invalidArguments: action.invalidArguments
  };
}

async function requestCompletion(settings, session, options = {}) {
  const requiresVision = options.requiresVision === true;
  const baseUrl = (requiresVision ? settings.api.visionBaseUrl || '' : settings.api.textBaseUrl || settings.api.baseUrl || '').replace(/\/+$/, '');
  const apiKey = requiresVision ? settings.api.visionApiKey : settings.api.textApiKey || settings.api.apiKey;
  if (requiresVision && (!baseUrl || !apiKey || !settings.api.visionModel?.trim())) {
    throw new Error('请先在“连接”页面填写视觉模型、视觉 API Base URL 和视觉 API Key。');
  }
  const model = requiresVision
    ? settings.api.visionModel.trim()
    : options.model || settings.api.textModel || settings.api.model;
  if (!baseUrl || !apiKey || !model) {
    throw new Error('请先在“连接”页面填写文本 API Base URL、文本模型名和文本 API Key。');
  }
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        // A previous app version could leave an image content part in the
        // in-memory session. Text providers must only receive plain text;
        // vision requests use their isolated prompt below instead.
        messages: [makeSystemMessage(settings), ...(requiresVision ? session : textSessionMessages(session))],
        temperature: settings.api.temperature,
        ...(options.allowTools === false ? {} : { tools: TOOL_DEFINITIONS, tool_choice: 'auto' })
      }),
      signal: AbortSignal.timeout(90000)
    });
  } catch (error) {
    const cause = error?.cause;
    const detail = [cause?.code, cause?.message].filter(Boolean).join(': ');
    throw new Error(`无法连接模型服务${detail ? `（${detail}）` : ''}：${error.message}`);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`模型服务返回 ${response.status}：${text.slice(0, 500)}`);
  }
  const payload = await response.json();
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error('模型服务未返回可用回复。');
  return {
    role: 'assistant',
    content: messageText(message.content),
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined
  };
}

function responsePayload(message) {
  const groupId = crypto.randomUUID();
  const actions = (message.tool_calls || []).map((toolCall) => createPendingAction(toolCall, groupId)).map(presentAction);
  return { content: message.content || '', actions };
}

function personaFallbackStyle(settings) {
  const persona = settings?.persona || {};
  const name = String(persona.name || '').trim();
  const relationship = String(persona.relationship || '');
  const source = `${persona.description || ''}\n${persona.examples || ''}`;
  // 降级回复不调用模型时，至少继承配置中的名字和语言示例里明显的语气词。
  // 这样网络短暂不可用时，现实问题仍不会退化成无人格的系统日志。
  let suffix = '';
  if (/哈哈|呵呵|嘻嘻/u.test(source)) suffix = ' 哈哈。';
  else if (/哎呀|呀[！!]|～|〜/u.test(source)) suffix = ' 呀。';
  else if (/哼|才不是|别误会/u.test(source)) suffix = ' 哼。';
  const address = ['博士', '指挥官', '主人', '队长', '老师', '阁下', '先生', '女士', '老板'].find((token) => relationship.includes(token)) || '';
  return { prefix: address ? `${address}，` : name ? `${name}：` : '', suffix };
}

function formatReadOnlyToolResult(name, result, userText = '', settings = {}) {
  if (!result || result.ok === false) return '';
  const style = personaFallbackStyle(settings);
  const wrap = (content) => `${style.prefix}${content}${style.suffix}`;
  if (name === 'get_current_time') {
    return wrap(`现在是 ${result.localTime || result.iso || '本机时间未知'}${result.timezone ? `（${result.timezone}）` : ''}。`);
  }
  if (name === 'get_system_location') {
    const place = [result.city, result.region, result.country].filter(Boolean).join('，');
    return wrap(place ? `根据网络大致定位，你现在位于${place}。这不是 GPS 精确位置。` : '已获取网络大致定位，但暂时没有解析出城市名称。');
  }
  if (name === 'get_weather') {
    const forecast = Array.isArray(result.forecast) ? result.forecast : [];
    if (/明后(?:两天|天)/u.test(userText) && forecast.length >= 3) {
      const days = forecast.slice(1, 3).map((day, index) => {
        const range = Number.isFinite(Number(day.min)) && Number.isFinite(Number(day.max)) ? `，${day.min}～${day.max}℃` : '';
        return `${index === 0 ? '明天' : '后天'}${day.weather || '天气信息未知'}${range}`;
      }).join('；');
      const current = result.current?.temperatureC !== undefined ? `当前 ${result.current.temperatureC}℃` : '';
      return wrap(`${result.location || '该地点'}明后两天天气：${days}。${current}${result.source ? `（数据源：${result.source}）` : ''}`);
    }
    const index = /大后天/u.test(userText) ? 3 : /后天/u.test(userText) ? 2 : /明天/u.test(userText) ? 1 : 0;
    const day = forecast[index] || forecast[0];
    const dayLabel = /大后天/u.test(userText) ? '大后天' : /后天/u.test(userText) ? '后天' : /明天/u.test(userText) ? '明天' : '今天';
    if (!day) return wrap(`${result.location || '该地点'}的天气数据暂时不完整。`);
    const range = Number.isFinite(Number(day.min)) && Number.isFinite(Number(day.max)) ? `，${day.min}～${day.max}℃` : '';
    const current = result.current?.temperatureC !== undefined ? `当前 ${result.current.temperatureC}℃，${result.current.weather || ''}` : '';
    return wrap(`${result.location || '该地点'}${dayLabel}预计${day.weather || '天气信息未知'}${range}。${current}${result.source ? `（数据源：${result.source}）` : ''}`);
  }
  if (name === 'search_web') {
    const results = Array.isArray(result.results) ? result.results.filter((item) => item?.title).slice(0, 3) : [];
    return wrap(results.length ? `已找到相关资料：${results.map((item, index) => `${index + 1}. ${item.title}`).join('；')}` : '搜索完成，但没有找到可用结果。');
  }
  if (name === 'read_text_document' || name === 'read_word_document') {
    const label = name === 'read_word_document' ? 'Word 文档' : '文本文档';
    const suffix = result.truncated ? '\n（内容较长，已截取前 160000 个字符。）' : '';
    return wrap(`已读取${label} ${result.filePath || ''}：\n${result.content || '（文档为空）'}${suffix}`);
  }
  return wrap(result.message || '');
}

function formatReadOnlyToolFailure(name, result, settings = {}) {
  if (!READ_ONLY_TOOLS.has(name) || !result?.error) return '';
  const labels = { get_current_time: '时间', get_system_location: '位置', get_weather: '天气', search_web: '搜索' };
  const style = personaFallbackStyle(settings);
  return `${style.prefix}${labels[name] || '这项信息'}暂时没查到：${result.error}${style.suffix}`;
}

function formatApplicationResult(result, app, settings = {}) {
  const labels = { wechat: '微信', notepad: '记事本', calculator: '计算器', explorer: '文件资源管理器', settings: '系统设置' };
  const label = labels[String(app || '').trim().toLowerCase()] || String(app || '这个应用').trim();
  const style = personaFallbackStyle(settings);
  if (result?.ok === false) return `${style.prefix}这次没能打开${label}：${result.error || '没有找到可显示的应用窗口。'}${style.suffix}`;
  return `${style.prefix}已经帮你打开${label}了。${style.suffix}`;
}

async function generateApplicationReply(settings, userText, result, app) {
  const fallback = formatApplicationResult(result, app, settings);
  const outcome = result?.ok === false
    ? `系统实际执行失败，原因是：${result.error || '没有找到可显示的应用窗口。'}`
    : `系统已经确认“${app}”的可见应用窗口已打开。`;
  const prompt = {
    role: 'user',
    content: `用户刚才说：“${String(userText || '').slice(0, 500)}”\n\n${outcome}\n\n请依据完整人格设定、使用者关系和语言示例，写一句自然的中文回应，让人感觉你确实在帮使用者完成事情。成功时可以带一点关心或下一步询问，但不要机械复述“操作完成”、工具名、进程或内部实现；失败时必须诚实说明没有完成，不能声称成功。不要调用工具，不要 Markdown，不要解释过程，只返回最终给使用者看的回复正文，长度不超过 120 字。`
  };
  try {
    const message = await requestCompletion(settings, [prompt], { allowTools: false });
    const content = messageText(message.content).trim();
    return content ? content.slice(0, 240) : fallback;
  } catch {
    return fallback;
  }
}

function formatWeatherNoteContent(result, userText) {
  const forecast = Array.isArray(result?.forecast) ? result.forecast : [];
  const formatDay = (label, day) => {
    if (!day) return `${label}天气数据暂缺`;
    const range = Number.isFinite(Number(day.min)) && Number.isFinite(Number(day.max)) ? `，${day.min}～${day.max}℃` : '';
    return `${label}${day.weather || '天气未知'}${range}`;
  };
  const location = result?.location || '未知城市';
  const days = /明后(?:两天|天)/u.test(userText)
    ? `${formatDay('明天', forecast[1])}；${formatDay('后天', forecast[2])}`
    : formatDay(/大后天/u.test(userText) ? '大后天' : /后天/u.test(userText) ? '后天' : /明天/u.test(userText) ? '明天' : '今天', forecast[/大后天/u.test(userText) ? 3 : /后天/u.test(userText) ? 2 : /明天/u.test(userText) ? 1 : 0]);
  const current = result?.current?.temperatureC !== undefined ? `当前${result.current.temperatureC}℃，${result.current.weather || ''}` : '';
  return `${location}${days}${current ? `；${current}` : ''}${result?.source ? `（数据源：${result.source}）` : ''}`;
}

async function handleCompoundWeatherNoteTask(settings, session, userText, task) {
  let weatherResult;
  try {
    weatherResult = await executeTool(task.weatherCall.function.name, parseToolArguments(task.weatherCall.function.arguments) || {}, false);
  } catch (error) {
    const failure = `天气暂时没有查到：${error.message}`;
    session.push({ role: 'assistant', content: failure });
    trimSession(session);
    return { content: failure, actions: [] };
  }
  if (!weatherResult?.ok) {
    const failure = `天气暂时没有查到：${weatherResult?.error || '返回结果无效。'}`;
    session.push({ role: 'assistant', content: failure });
    trimSession(session);
    return { content: failure, actions: [] };
  }
  const weatherReply = formatReadOnlyToolResult('get_weather', weatherResult, userText, settings);
  if (settings.automation?.enabled !== true) {
    const content = `${weatherReply}\n如果要我打开记事本并把结果写入文件，请先在“自动化”页面开启电脑操作权限。`;
    session.push({ role: 'assistant', content });
    trimSession(session);
    return { content, actions: [] };
  }
  let opened;
  try {
    opened = await executeTool(task.openCall.function.name, { app: 'notepad' }, true);
  } catch (error) {
    const content = `${weatherReply}\n天气已查到，但记事本没有成功打开：${error.message}`;
    session.push({ role: 'assistant', content });
    trimSession(session);
    return { content, actions: [] };
  }
  if (!opened?.ok) {
    const content = `${weatherReply}\n天气已查到，但记事本没有成功打开。`;
    session.push({ role: 'assistant', content });
    trimSession(session);
    return { content, actions: [] };
  }
  const absoluteNotePath = path.resolve(__dirname, '..', task.filePath);
  const mode = fs.existsSync(absoluteNotePath) ? 'append' : 'create';
  const note = `${new Date().toLocaleString('zh-CN')}：${formatWeatherNoteContent(weatherResult, userText)}\n`;
  const writeCall = localToolCall('write_text_document', {
    file_path: task.filePath,
    content: note,
    mode,
    open_in_notepad: true
  });
  if (canAutoExecuteToolCalls(settings, [writeCall])) {
    try {
      const written = await executeTool('write_text_document', JSON.parse(writeCall.function.arguments), true);
      const openResult = written.notepadOpened
        ? '，并用记事本打开了文件。'
        : written.notepadError
          ? `，但打开记事本失败：${written.notepadError}`
          : '。';
      const content = `${weatherReply}\n已经把天气记录写入 ${task.filePath}${openResult}`;
      session.push({ role: 'assistant', content });
      trimSession(session);
      return { content, actions: [] };
    } catch (error) {
      const content = `${weatherReply}\n天气已查到，但写入记事本失败：${error.message}`;
      session.push({ role: 'assistant', content });
      trimSession(session);
      return { content, actions: [] };
    }
  }
  const action = createPendingAction(writeCall, crypto.randomUUID());
  const content = `${weatherReply}\n记事本已经打开，我准备把这条天气记录写入 ${task.filePath}。写入文件需要你的确认。`;
  session.push({ role: 'assistant', content: '', tool_calls: [writeCall] });
  trimSession(session);
  return { content, actions: [presentAction(action)] };
}

async function generateGreeting(settings, surface = 'console') {
  const prompt = {
    role: 'user',
    content: `这是用户刚打开${surface === 'bubble' ? '桌宠小对话气泡' : '桌宠控制面板'}。请严格依据你的人格设定、你与使用者的关系和语言示例，主动说一句自然的中文欢迎语，体现你的性格和关系。只输出这一句欢迎语，不要解释、不要 Markdown、不要调用工具，长度不超过 120 字。`
  };
  let message;
  try {
    message = await requestCompletion(settings, [prompt], { allowTools: false });
  } catch (error) {
    // A fresh portable install has no API key yet. Keep startup usable and
    // explain the next step in the persona's voice instead of rejecting the
    // IPC handler with an unhandled configuration error.
    if (String(error?.message || '').startsWith('请先在“连接”页面填写文本 API')) {
      const persona = settings.persona || {};
      const name = String(persona.name || '').trim();
      const relationship = String(persona.relationship || '').trim();
      const identity = name ? `我是${name}` : '我已经准备好了';
      const role = relationship ? `，你的${relationship}` : '';
      return `你好，${identity}${role}。我已经准备好了；在“连接”页面配置文本模型后，就能正式和你聊天。`;
    }
    throw error;
  }
  const greeting = messageText(message.content).trim().replace(/^['"“”]+|['"“”]+$/g, '');
  if (!greeting) throw new Error('模型未返回欢迎语。');
  return greeting.slice(0, 240);
}

function compactVisionImage(imageBase64) {
  if (!nativeImage?.createFromBuffer || typeof imageBase64 !== 'string') return null;
  try {
    const source = nativeImage.createFromBuffer(Buffer.from(imageBase64, 'base64'));
    const size = source.getSize();
    if (!size.width || !size.height) return null;
    const original = source.toPNG();
    // Keep ordinary bubble crops lossless. Full high-resolution screenshots
    // can exceed a provider's request limit, so cap them before retrying.
    if (original.length <= 3 * 1024 * 1024 && Math.max(size.width, size.height) <= 2200) return null;
    const scale = Math.min(1, 2200 / size.width, 2200 / size.height);
    const resized = scale < 1
      ? source.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'best' })
      : source;
    const jpeg = resized.toJPEG(88);
    return jpeg.length ? { base64: jpeg.toString('base64'), mimeType: 'image/jpeg' } : null;
  } catch {
    return null;
  }
}

async function runWechatVisionPass(settings, imageBase64, instruction) {
  const request = async (payload, mimeType = 'image/png') => {
    const prompt = {
      role: 'user',
      content: [
        { type: 'text', text: instruction },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${payload}`, detail: 'high' } }
      ]
    };
    return requestCompletion(settings, [prompt], {
      allowTools: false,
      model: settings.api.visionModel,
      requiresVision: true
    });
  };
  let message;
  try {
    message = await request(imageBase64);
  } catch (error) {
    const compact = compactVisionImage(imageBase64);
    if (!compact || !/无法连接模型服务|fetch failed|请求体|413|超时/i.test(String(error.message || ''))) {
      throw new Error(`视觉模型识别微信截图失败：${error.message}`);
    }
    try {
      message = await request(compact.base64, compact.mimeType);
    } catch (retryError) {
      throw new Error(`视觉模型识别微信截图失败：${retryError.message}（已尝试压缩截图重试）`);
    }
  }
  return parseWechatObservation(message.content);
}

async function analyzeWechatImage(settings, imageBase64, yoloDetection) {
  const image = typeof imageBase64 === 'string' ? imageBase64.trim() : '';
  if (!image) throw new Error('微信截图为空。');
  const rawYolo = JSON.stringify(yoloDetection || {});
  const latest = yoloDetection?.latest;
  if (!yoloDetection?.available || !latest || !['other', 'self'].includes(latest.sender)) {
    return {
      sender: 'unknown', text: '', position: 'unknown', bubbleColor: 'unknown', confidence: 0,
      raw: rawYolo,
      senderReason: yoloDetection?.error
        ? `本地 YOLO 尚不可用：${yoloDetection.error}`
        : '本地 YOLO 未检测到可信的最新微信气泡，已阻止自动回复。'
    };
  }
  const position = latest.sender === 'self' ? 'right' : 'left';
  const bubbleColor = latest.sender === 'self' ? 'green' : 'gray_black';
  if (latest.sender === 'self') {
    return {
      sender: 'self', text: '', position, bubbleColor,
      confidence: Number(latest.confidence) || 0, raw: rawYolo,
      senderReason: '本地 YOLO 将纵坐标最低的气泡标记为 self，未调用视觉模型。'
    };
  }
  const bubbleImage = cropWechatBubble(image, latest);
  const instruction = 'YOLO 已确认这张图片只包含微信聊天中纵坐标最低的对方气泡。你只负责读取这个气泡里的文字，不要判断发送者，不要参考人格，不要生成回复，不要调用工具。请只返回识别到的完整文字；无法读取时只返回 NO_MESSAGE。';
  let vision = await runWechatVisionPass(settings, bubbleImage, instruction);
  let text = (vision.text || messageText(vision.raw)).trim();
  // Some providers still fail on a tiny crop even after enlargement. Retry
  // once with the original screenshot and explicit YOLO coordinates so the
  // provider can locate the same bubble itself.
  if (!text && bubbleImage !== image) {
    let captureSize = { width: 0, height: 0 };
    try { captureSize = nativeImage.createFromBuffer(Buffer.from(image, 'base64')).getSize(); } catch { /* use YOLO metadata if available */ }
    const imageWidth = Math.round(Number(latest.imageWidth) || captureSize.width || 0);
    const imageHeight = Math.round(Number(latest.imageHeight) || captureSize.height || 0);
    const retryInstruction = `请只读取 YOLO 框选的微信对方气泡文字，不要判断发送者，不要生成回复。截图实际像素约 ${imageWidth}×${imageHeight}；气泡框为 x=${Math.round(latest.x)}, y=${Math.round(latest.y)}, right=${Math.round(latest.right)}, bottom=${Math.round(latest.bottom)}。只返回完整文字，无法读取时只返回 NO_MESSAGE。`;
    const retry = await runWechatVisionPass(settings, image, retryInstruction);
    text = (retry.text || messageText(retry.raw)).trim();
    vision = { text, raw: JSON.stringify({ cropped: vision.raw, fullScreenshotRetry: retry.raw }) };
  }
  const cleanText = /^NO_(?:MESSAGE|NEW_MESSAGE|REPLY)$/i.test(text) ? '' : text;
  return {
    sender: 'other', text: cleanText.slice(0, 4000), position, bubbleColor,
    confidence: Number(latest.confidence) || 0, raw: JSON.stringify({ yolo: yoloDetection, vision: vision.raw }),
    senderReason: '本地 YOLO 将纵坐标最低的气泡标记为 other；视觉模型只读取该气泡文字。'
  };
}

function addWechatObservationToSession(session, observation) {
  session.push({
    role: 'user',
    visible: false,
    content: observation?.text
      ? `视觉模型从微信截图中识别到最新消息：\n发送者：${observation.sender}\n位置：${observation.position || 'unknown'}\n气泡颜色：${observation.bubbleColor || 'unknown'}\n消息：${observation.text}\n\n只有发送者为 other 才能把它当作对方的新消息。若需要回复，请把自己视为使用者的代笔：用使用者第一人称生成可直接发送的微信正文，保留使用者原意，不要自称桌宠或模型，不要添加未经确认的承诺；人格设定只用于自然调整语气。需要电脑操作时按规则调用工具。`
      : '视觉模型未识别到明确且可用的新微信消息。请不要猜测或编造消息内容。'
  });
}

async function chat(settings, userText, sessionId = 'default') {
  const text = typeof userText === 'string' ? userText.trim() : '';
  if (!text) throw new Error('请输入一条消息。');
  if (text.length > 8000) throw new Error('消息不能超过 8000 个字符。');
  const session = getSession(sessionId);
  session.push({ role: 'user', content: text });
  trimSession(session);

  const compoundTask = inferCompoundWeatherNoteTask(text);
  if (compoundTask) return handleCompoundWeatherNoteTask(settings, session, text, compoundTask);
  const documentCall = inferDocumentToolCall(text);
  const openDocumentCall = !documentCall ? inferOpenDocumentIntent(text) : null;
  // Opening an application is an explicitly authorized, low-risk operation.
  // Dispatch it locally before asking the model so a provider that answers
  // "好的，我来打开" without a tool call cannot produce a false success.
  const explicitOpenCall = !documentCall && !openDocumentCall && settings.automation?.enabled === true ? inferOpenApplicationIntent(text) : null;
  if (settings.automation?.enabled === true && !documentCall && !openDocumentCall && !explicitOpenCall && isOpenApplicationRequest(text)) {
    const clarification = '想打开哪个应用？请告诉我名称，例如微信、记事本或计算器。';
    session.push({ role: 'assistant', content: clarification });
    trimSession(session);
    return { content: clarification, actions: [] };
  }
  if (explicitOpenCall) {
    const args = parseToolArguments(explicitOpenCall.function.arguments) || {};
    let result;
    try {
      result = await executeTool(explicitOpenCall.function.name, args, true);
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    const summary = await generateApplicationReply(settings, text, result, args.app);
    session.push({ role: 'assistant', content: summary });
    trimSession(session);
    return { content: summary, actions: [] };
  }
  if (openDocumentCall) {
    if (settings.automation?.enabled !== true) {
      const message = '要打开这个文档，请先在“自动化”页面开启电脑操作权限。';
      session.push({ role: 'assistant', content: message });
      trimSession(session);
      return { content: message, actions: [] };
    }
    let result;
    const args = parseToolArguments(openDocumentCall.function.arguments) || {};
    try {
      result = await executeTool(openDocumentCall.function.name, args, true);
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    const summary = await generateApplicationReply(settings, text, result, 'notepad');
    session.push({ role: 'assistant', content: summary });
    trimSession(session);
    return { content: summary, actions: [] };
  }

  const realityCall = !documentCall ? inferRealityToolCall(text) : null;
  let message = documentCall
    ? { role: 'assistant', content: '', tool_calls: [documentCall] }
    : realityCall
    ? { role: 'assistant', content: '', tool_calls: [realityCall] }
    : await requestCompletion(settings, session);
  // Some text-only providers ignore the tools field and answer the command as
  // prose. For an explicit request to open one of the existing safe apps,
  // recover the tool call locally so the permission/confirmation flow still
  // works and the request is not silently treated as ordinary conversation.
  if ((!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) && settings.automation?.enabled === true) {
    const inferredCall = inferOpenApplicationIntent(text) || inferOpenDocumentIntent(text) || inferDocumentToolCall(text);
    if (inferredCall) message = { ...message, tool_calls: [inferredCall] };
  }
  let autoRounds = 0;
  while (canAutoExecuteToolCalls(settings, message.tool_calls) && autoRounds < 3) {
    autoRounds += 1;
    session.push(message);
    let wechatObservation;
    let lastToolResult;
    let lastToolName = '';
    for (const toolCall of message.tool_calls) {
      lastToolName = toolCall.function?.name || '';
      const args = parseToolArguments(toolCall.function?.arguments);
      let result;
      if (args === null) {
        result = { ok: false, error: '工具参数无效。' };
      } else {
        try {
          result = await executeTool(toolCall.function?.name, args, true);
        } catch (error) {
          result = { ok: false, error: error.message };
        }
      }
      lastToolResult = result;
      if (result && result.__wechatImageBase64) {
        try {
          const yoloDetection = result.path ? await detectWeChatBubble(result.path) : { available: false, error: '截图路径为空。' };
          wechatObservation = await analyzeWechatImage(settings, result.__wechatImageBase64, yoloDetection);
        } finally {
          if (result.path) {
            try { fs.unlinkSync(result.path); } catch { /* best-effort cleanup */ }
          }
        }
        const toolSummary = { ...result };
        delete toolSummary.__wechatImageBase64;
        toolSummary.wechatSender = wechatObservation.sender;
        toolSummary.recognizedText = wechatObservation.text || 'NO_NEW_MESSAGE';
        session.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(toolSummary) });
      } else {
        session.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
      }
    }
    if (wechatObservation !== undefined) addWechatObservationToSession(session, wechatObservation);
    if (realityCall && autoRounds === 1) {
      session.push({
        role: 'user',
        visible: false,
        content: '这是刚刚获取到的现实信息工具结果。请结合系统中的人格设定、使用者关系和语言示例，用自然的桌宠口吻回答原问题；不要直接复述 JSON、字段名或“操作已执行”，也不要编造工具没有提供的信息。'
      });
    }
    trimSession(session);
    try {
      message = await requestCompletion(settings, session);
    } catch (error) {
      // A provider may execute the tool but reject the follow-up request that
      // contains tool-role messages. Do not report the real operation as a
      // failure in that case; return the concrete execution result instead.
      const summary = lastToolResult?.ok === false
        ? (formatReadOnlyToolFailure(lastToolName, lastToolResult, settings) || `操作未完成：${lastToolResult.error || '系统拒绝执行。'}`)
        : (formatReadOnlyToolResult(lastToolName, lastToolResult, text, settings) || lastToolResult?.message || '操作已执行。');
      session.push({ role: 'assistant', content: summary });
      trimSession(session);
      return { content: summary, actions: [] };
    }
  }
  session.push(message);
  trimSession(session);
  return responsePayload(message);
}

async function chatWithWechatImage(settings, imageBase64, yoloDetection) {
  const observation = await analyzeWechatImage(settings, imageBase64, yoloDetection);
  if (!observation.text || observation.sender !== 'other') {
    return {
      reply: '',
      raw: observation.sender === 'self' ? 'SELF_MESSAGE' : 'NO_NEW_MESSAGE',
      sender: observation.sender,
      recognizedText: observation.text,
      visionRaw: observation.raw,
      senderReason: observation.senderReason
    };
  }
  const prompt = {
    role: 'user',
    content: `视觉模型刚刚从微信截图中识别到最新消息：\n发送者：${observation.sender}\n消息：${observation.text}\n\n请确认 sender=other 后，帮使用者回复这条微信。你是使用者的代笔，不是对方正在聊天的独立角色：用使用者第一人称，结合上下文和当前人格设定写出可以直接发送的正文；不要自称桌宠、智能体或模型，不要说“我替你回复”，不要替使用者添加承诺、态度或敏感信息。人格只用于让措辞自然、有一致的语气。只返回回复正文，不要加引号、前缀、解释或 Markdown；不要调用工具。`
  };
  let message;
  try {
    // The vision result is plain text now; the text model owns personality and
    // response generation, so the two APIs never share image content.
    message = await requestCompletion(settings, [prompt], { allowTools: false });
  } catch (error) {
    throw new Error(`纯文本模型生成微信回复失败：${error.message}`);
  }
  const content = messageText(message.content).trim();
  if (!content || /^NO_REPLY$/i.test(content)) {
    return { reply: '', raw: content, sender: observation.sender, recognizedText: observation.text, visionRaw: observation.raw, senderReason: observation.senderReason };
  }
  return { reply: content.slice(0, 2000), raw: content, sender: observation.sender, recognizedText: observation.text, visionRaw: observation.raw, senderReason: observation.senderReason };
}

async function decideAction(settings, actionId, approved) {
  const action = pendingActions.get(actionId);
  if (!action) throw new Error('此操作请求已失效。');
  pendingActions.delete(actionId);

  const session = getSession('default');
  if (!approved) {
    session.push({ role: 'tool', tool_call_id: action.toolCallId, content: JSON.stringify({ ok: false, cancelled: true, message: '用户拒绝了该操作。' }) });
    persistSessions();
    return { toolResult: '已拒绝该操作。', content: '', actions: [] };
  }
  if (action.invalidArguments) {
    return { toolResult: '未执行：工具参数无效。', content: '', actions: [] };
  }

  let result;
  try {
    result = await executeTool(action.name, action.args, settings.automation.enabled);
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  let wechatObservation;
  if (result && result.__wechatImageBase64) {
    try {
      const yoloDetection = result.path ? await detectWeChatBubble(result.path) : { available: false, error: '截图路径为空。' };
      wechatObservation = await analyzeWechatImage(settings, result.__wechatImageBase64, yoloDetection);
    } finally {
      if (result.path) {
        try { fs.unlinkSync(result.path); } catch { /* best-effort cleanup */ }
      }
    }
    const toolSummary = { ...result };
    delete toolSummary.__wechatImageBase64;
    toolSummary.wechatSender = wechatObservation.sender;
    toolSummary.recognizedText = wechatObservation.text || 'NO_NEW_MESSAGE';
    session.push({ role: 'tool', tool_call_id: action.toolCallId, content: JSON.stringify(toolSummary) });
  } else {
    session.push({ role: 'tool', tool_call_id: action.toolCallId, content: JSON.stringify(result) });
  }
  if (wechatObservation !== undefined) addWechatObservationToSession(session, wechatObservation);
  trimSession(session);

  // A provider may return multiple tool calls despite the instruction. Wait until
  // every call from that assistant message has been resolved before asking it again.
  const hasSiblingAction = [...pendingActions.values()].some((item) => item.groupId === action.groupId);
  if (hasSiblingAction) {
    return { toolResult: result.message || result.error || '操作已处理。', content: '', actions: [] };
  }

  try {
    const message = await requestCompletion(settings, session);
    session.push(message);
    trimSession(session);
    return { toolResult: action.name === 'open_application' ? formatApplicationResult(result, action.args?.app, settings) : (result.message || result.error || '操作完成。'), ...responsePayload(message) };
  } catch (error) {
    return { toolResult: result.message || result.error || '操作完成。', content: `操作结果已记录，但暂时无法向模型请求总结：${error.message}`, actions: [] };
  }
}

function clearSession(sessionId = 'default') {
  loadPersistedSessions();
  sessions.set(sessionId, []);
  for (const [id] of pendingActions) pendingActions.delete(id);
  persistSessions();
}

module.exports = { analyzeWechatImage, chat, chatWithWechatImage, clearSession, decideAction, generateGreeting, getSessionHistory, recordGreeting, inferOpenApplicationIntent, inferOpenDocumentIntent, isOpenApplicationRequest, inferDocumentToolCall, inferCompoundWeatherNoteTask, inferRealityToolCall, canAutoExecuteToolCalls, formatReadOnlyToolResult, formatApplicationResult, generateApplicationReply };
