const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { desktopCapturer, nativeImage, shell } = require('electron');

const execFileAsync = promisify(execFile);
const CAPTURE_DIR = path.join(__dirname, '..', '.runtime', 'wechat-captures');
const DESKTOP_CAPTURE_DIR = path.join(__dirname, '..', '.runtime', 'desktop-captures');
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DESKTOP_ROOT = path.resolve(os.homedir(), 'Desktop');
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 160000;
const TEXT_DOCUMENT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.log', '.csv', '.json', '.xml', '.yaml', '.yml', '.ini', '.cfg']);
let lastCreatedDocumentPath = '';
const READ_ONLY_TOOLS = new Set([
  'get_current_time', 'get_system_location', 'get_weather', 'search_web', 'get_wechat_status',
  'read_text_document', 'read_word_document', 'capture_desktop_screen'
]);
const CONFIRMATION_REQUIRED_TOOLS = new Set([
  'edit_text_document', 'edit_word_document'
]);

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '读取这台电脑的当前本地时间、日期和时区。询问现在几点、今天日期时必须调用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_system_location',
      description: '通过网络 IP 地理定位读取当前大致城市、地区、国家和坐标；结果可能是近似位置，不是 GPS 精确位置。',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询实时天气和未来几天预报。location 可填写城市名；省略时使用当前网络大致位置。',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string', description: '城市或地区名称，可省略。' } },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: '联网搜索现实世界信息、新闻、网页资料或模型知识可能过时的内容。返回搜索摘要和来源链接。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的问题或关键词。' },
          limit: { type: 'integer', minimum: 1, maximum: 8, description: '最多返回几条结果，默认 5。' }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: '在默认浏览器打开一个 HTTP 或 HTTPS 网页。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要打开的完整网页地址。' } },
        required: ['url'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_application',
      description: '打开一个受限的 Windows 应用。优先使用记事本、计算器、文件资源管理器、设置或微信等别名；也可使用 Windows 开始菜单中已安装应用的显示名称。不会执行任意命令或任意文件路径。',
      parameters: {
        type: 'object',
        properties: {
          app: { type: 'string', description: '应用别名或 Windows 开始菜单中的应用显示名称，例如 wechat、微信、Chrome、QQ。' }
        },
        required: ['app'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'focus_wechat',
      description: '恢复并置前微信窗口，但不读取或发送聊天内容。',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'capture_wechat_window',
      description: '读取当前微信聊天窗口画面；随后由本地 YOLO 判断最新气泡归属，再由视觉模型读取对方气泡文字；不会发送消息。',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'capture_desktop_screen',
      description: '截取当前 Windows 桌面的完整可见画面（包含正在显示的窗口），供视觉模型读取屏幕上的文字、界面和其他内容；只读，不修改电脑。用户询问“屏幕上/桌面上/电脑上显示什么”或要求看当前界面时必须调用。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_wechat_status',
      description: '检查 Windows 上是否有微信或 WeChat 进程正在运行，并返回可用窗口信息。',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_text_to_active_wechat',
      description: '激活标题含“微信”或“WeChat”的窗口，将文字粘贴到当前输入框；仅在用户确认后可发送。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要粘贴的消息文本，最多 2000 个字符。' },
          send: { type: 'boolean', description: '是否在粘贴后按 Enter 发送；默认 true。' }
        },
        required: ['text'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_text_document',
      description: '读取项目目录或桌面内的 UTF-8 文本文档（如 .txt、.md、.csv、.json），用于阅读记事本文件内容。只读，不修改文件。未指定路径时，保存类操作默认使用 desktop/。',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string', description: '项目内路径或 desktop/xxx.txt；未指定路径时保存到桌面。' } },
        required: ['file_path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_text_document_in_notepad',
      description: '用 Windows 记事本打开项目或桌面内已有的文本文档，并验证记事本窗口是否可见。',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string', description: '项目或 desktop/ 下的 .txt/.md 等文本文件路径。' } },
        required: ['file_path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_text_document',
      description: '创建或写入项目目录或桌面内的 UTF-8 文本文档。会修改文件；mode 可为 create、replace、append 或 prepend。未指定路径时优先保存到桌面。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '项目或 desktop/ 下的 .txt/.md 等文本文件路径。' },
          content: { type: 'string', description: '要写入的完整文本内容。' },
          mode: { type: 'string', enum: ['create', 'replace', 'append', 'prepend'], description: '写入方式，默认 replace。' },
          open_in_notepad: { type: 'boolean', description: '写入后是否用 Windows 记事本打开该文件，默认 false。' }
        },
        required: ['file_path', 'content'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_text_document',
      description: '按精确文本查找并编辑项目目录或桌面内的文本文档。会修改文件，必须等待用户确认；默认替换全部匹配项。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '项目或 desktop/ 下的文本文件路径。' },
          old_text: { type: 'string', description: '要查找的原文，必须提供精确文本。' },
          new_text: { type: 'string', description: '替换后的文本。' },
          replace_all: { type: 'boolean', description: '是否替换全部匹配项，默认 true。' }
        },
        required: ['file_path', 'old_text', 'new_text'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_word_document',
      description: '读取项目目录或桌面内的 .docx Word 文档正文。只读，不修改文件；需要本机安装 Microsoft Word。',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string', description: '项目内或 desktop/ 下的 .docx 文件路径。' } },
        required: ['file_path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_word_document',
      description: '创建项目目录或桌面内的 .docx Word 文档并写入正文。需要本机安装 Microsoft Word；未指定路径时优先保存到桌面。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '项目或 desktop/ 下的新 .docx 文件路径。' },
          content: { type: 'string', description: '要写入 Word 文档的正文。' }
        },
        required: ['file_path', 'content'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_word_document',
      description: '按精确文本查找并编辑项目目录或桌面内的 .docx Word 文档正文。会修改文件，必须等待用户确认；需要本机安装 Microsoft Word。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '项目或 desktop/ 下的 .docx 文件路径。' },
          old_text: { type: 'string', description: '要查找的原文，必须提供精确文本。' },
          new_text: { type: 'string', description: '替换后的文本。' },
          replace_all: { type: 'boolean', description: '是否替换全部匹配项，默认 true。' }
        },
        required: ['file_path', 'old_text', 'new_text'],
        additionalProperties: false
      }
    }
  }
];

const WEATHER_CODE_TEXT = {
  0: '晴朗', 1: '大部晴朗', 2: '局部多云', 3: '阴天',
  45: '有雾', 48: '冻雾', 51: '小毛毛雨', 53: '毛毛雨', 55: '较强毛毛雨',
  56: '冻毛毛雨', 57: '较强冻毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨', 71: '小雪', 73: '中雪', 75: '大雪',
  77: '雪粒', 80: '小阵雨', 81: '中阵雨', 82: '强阵雨',
  85: '小阵雪', 86: '强阵雪', 95: '雷暴', 96: '雷暴伴小冰雹', 99: '雷暴伴大冰雹'
};

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`网络请求返回 ${response.status}`);
  return response.json();
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { accept: 'text/html,application/xhtml+xml', ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`网络请求返回 ${response.status}`);
  return response.text();
}

function getCurrentTime() {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  return {
    ok: true,
    iso: now.toISOString(),
    timezone,
    localTime: new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'medium' }).format(now)
  };
}

async function getSystemLocation() {
  const endpoints = ['https://ipapi.co/json/', 'https://ipwho.is/'];
  let lastError;
  for (const endpoint of endpoints) {
    try {
      const data = await fetchJson(endpoint);
      if (data.success === false || data.error) throw new Error(data.reason || data.message || '地理定位失败');
      const latitude = Number(data.latitude ?? data.lat);
      const longitude = Number(data.longitude ?? data.lon);
      return {
        ok: true,
        approximate: true,
        city: data.city || data.city_name || '',
        region: data.region || data.region_name || '',
        country: data.country_name || data.country || '',
        countryCode: data.country_code || '',
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        timezone: data.timezone?.name || data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
        source: endpoint.includes('ipapi') ? 'ipapi.co' : 'ipwho.is'
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法获取网络大致位置：${lastError?.message || '网络不可用'}`);
}

async function geocodeWeatherLocation(location) {
  const query = String(location || '').trim();
  if (!query) return getSystemLocation();
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=zh&format=json`;
  const data = await fetchJson(url);
  const result = data.results?.[0];
  if (!result) throw new Error(`没有找到“${query}”对应的城市。`);
  return {
    ok: true,
    approximate: false,
    city: result.name || query,
    region: result.admin1 || '',
    country: result.country || '',
    countryCode: result.country_code || '',
    latitude: Number(result.latitude),
    longitude: Number(result.longitude),
    timezone: result.timezone || 'auto',
    source: 'Open-Meteo geocoding'
  };
}

async function getWeather(location) {
  try {
    const place = await geocodeWeatherLocation(location);
    if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) throw new Error('天气位置缺少有效坐标。');
    const query = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset',
      forecast_days: '4',
      timezone: 'auto'
    });
    const data = await fetchJson(`https://api.open-meteo.com/v1/forecast?${query}`);
    const current = data.current || {};
    const daily = data.daily || {};
    const forecast = Array.isArray(daily.time) ? daily.time.map((date, index) => ({
      date,
      weather: WEATHER_CODE_TEXT[daily.weather_code?.[index]] || `天气代码 ${daily.weather_code?.[index] ?? '未知'}`,
      weatherCode: daily.weather_code?.[index],
      max: daily.temperature_2m_max?.[index],
      min: daily.temperature_2m_min?.[index],
      sunrise: daily.sunrise?.[index],
      sunset: daily.sunset?.[index]
    })) : [];
    return {
      ok: true,
      location: `${place.city}${place.region ? `，${place.region}` : ''}${place.country ? `，${place.country}` : ''}`,
      approximateLocation: place.approximate,
      timezone: data.timezone || place.timezone,
      observedAt: current.time,
      current: {
        weather: WEATHER_CODE_TEXT[current.weather_code] || `天气代码 ${current.weather_code ?? '未知'}`,
        weatherCode: current.weather_code,
        temperatureC: current.temperature_2m,
        apparentTemperatureC: current.apparent_temperature,
        relativeHumidity: current.relative_humidity_2m,
        windSpeedKmh: current.wind_speed_10m
      },
      forecast,
      source: 'Open-Meteo'
    };
  } catch (openMeteoError) {
    // Open-Meteo 偶尔会因 DNS、地区网络或临时限流失败；城市明确时使用
    // wttr.in 作为备用，不让用户只看到无上下文的 “fetch failed”。
    const query = String(location || '').trim();
    if (!query) throw openMeteoError;
    try {
      const data = await fetchJson(`https://wttr.in/${encodeURIComponent(query)}?format=j1`, {
        headers: { 'user-agent': 'listagent desktop pet' }
      });
      const current = data.current_condition?.[0] || {};
      const area = data.nearest_area?.[0] || {};
      const areaName = area.areaName?.[0]?.value || query;
      const region = area.region?.[0]?.value || '';
      const country = area.country?.[0]?.value || '';
      const forecast = (Array.isArray(data.weather) ? data.weather : []).slice(0, 4).map((day) => ({
        date: day.date,
        weather: day.hourly?.[4]?.weatherDesc?.[0]?.value?.trim() || '天气信息未知',
        max: Number(day.maxtempC),
        min: Number(day.mintempC),
        sunrise: day.astronomy?.[0]?.sunrise,
        sunset: day.astronomy?.[0]?.sunset
      }));
      return {
        ok: true,
        location: `${areaName}${region ? `，${region}` : ''}${country ? `，${country}` : ''}`,
        approximateLocation: false,
        timezone: 'local',
        observedAt: current.observation_time,
        current: {
          weather: current.weatherDesc?.[0]?.value?.trim() || '天气信息未知',
          temperatureC: Number(current.temp_C),
          apparentTemperatureC: Number(current.FeelsLikeC),
          relativeHumidity: Number(current.humidity),
          windSpeedKmh: Number(current.windspeedKmph)
        },
        forecast,
        source: 'wttr.in（Open-Meteo 备用）'
      };
    } catch (fallbackError) {
      throw new Error(`天气服务暂时不可用：主服务 ${openMeteoError.message || '请求失败'}；备用服务 ${fallbackError.message || '请求失败'}`);
    }
  }
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

function flattenRelatedTopics(topics, output) {
  for (const topic of Array.isArray(topics) ? topics : []) {
    if (topic.Topics) flattenRelatedTopics(topic.Topics, output);
    else if (topic.Text || topic.FirstURL) output.push({ title: topic.Text || '', url: topic.FirstURL || '', snippet: topic.Text || '' });
  }
}

function parseBingResults(html, limit) {
  const results = [];
  const blocks = String(html || '').match(/<li[^>]*class=["'][^"']*b_algo[^"']*["'][\s\S]*?<\/li>/gi) || [];
  for (const block of blocks) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({ title: stripHtml(link[2]), url: stripHtml(link[1]), snippet: stripHtml(snippet?.[1] || '') });
    if (results.length >= limit) break;
  }
  return results;
}

async function searchWeb(query, limit = 5) {
  const text = String(query || '').trim();
  if (!text) throw new Error('搜索关键词不能为空。');
  const count = Math.min(8, Math.max(1, Number(limit) || 5));
  let lastError;
  try {
    const html = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(text)}&count=${count}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }
    });
    const results = parseBingResults(html, count);
    if (results.length) return { ok: true, query: text, results, source: 'Bing Web Search' };
    lastError = new Error('Bing 未返回可解析的结果');
  } catch (error) {
    lastError = error;
  }
  try {
    const data = await fetchJson(`https://api.duckduckgo.com/?q=${encodeURIComponent(text)}&format=json&no_html=1&no_redirect=1&skip_disambig=0`);
    const results = [];
    if (data.AbstractText) results.push({ title: data.Heading || text, url: data.AbstractURL || '', snippet: data.AbstractText });
    flattenRelatedTopics(data.RelatedTopics, results);
    return { ok: true, query: text, results: results.filter((item) => item.snippet || item.url).slice(0, count), source: 'DuckDuckGo Instant Answer' };
  } catch (error) {
    throw new Error(`联网搜索失败：${lastError?.message || error.message}`);
  }
}

function runPowerShell(script, timeout = 15000) {
  return execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script], {
    windowsHide: true,
    timeout,
    maxBuffer: 1024 * 1024
  });
}

function parsePowerShellJson(stdout, fallback) {
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    if (parsed === null || typeof parsed === 'undefined') return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

function resolveDocumentPath(rawPath, kind, { mustExist = true } = {}) {
  const input = String(rawPath || '').trim();
  if (!input) throw new Error('文档路径不能为空。');
  const desktopAlias = /^(?:desktop|桌面)[\\/]/iu.test(input);
  const aliasPath = desktopAlias ? input.replace(/^(?:desktop|桌面)[\\/]/iu, '') : input;
  const resolved = path.resolve(desktopAlias ? DESKTOP_ROOT : PROJECT_ROOT, aliasPath);
  const projectRelative = path.relative(PROJECT_ROOT, resolved);
  const desktopRelative = path.relative(DESKTOP_ROOT, resolved);
  const insideProject = projectRelative !== '..' && !projectRelative.startsWith('..' + path.sep) && !path.isAbsolute(projectRelative);
  const insideDesktop = desktopRelative !== '..' && !desktopRelative.startsWith('..' + path.sep) && !path.isAbsolute(desktopRelative);
  if (!insideProject && !insideDesktop) {
    throw new Error('为安全起见，文档只能位于 listagent 项目目录或桌面目录内。');
  }
  const relative = insideProject ? projectRelative : '';
  const protectedRoots = ['data', 'node_modules', '.runtime', '.git'];
  if (insideProject && protectedRoots.some((root) => relative === root || relative.startsWith(root + path.sep))) {
    throw new Error('不能读写项目的运行数据、依赖或内部目录。请使用 documents/ 目录或 desktop/ 路径保存文档。');
  }
  const extension = path.extname(resolved).toLowerCase();
  if (kind === 'text' && !TEXT_DOCUMENT_EXTENSIONS.has(extension)) {
    throw new Error(`不支持的文本文档格式：${extension || '无扩展名'}。支持 .txt、.md、.csv、.json 等文本格式。`);
  }
  if (kind === 'word' && extension !== '.docx') throw new Error('Word 文档目前仅支持 .docx 格式。');
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error('文档路径不是文件。');
    if (stat.size > MAX_DOCUMENT_BYTES) throw new Error('文档超过 5 MB，暂不读取或修改。');
  } else if (mustExist) {
    throw new Error(`找不到文档：${input}`);
  }
  return resolved;
}

function documentResultPath(filePath) {
  const desktopRelative = path.relative(DESKTOP_ROOT, filePath);
  if (desktopRelative !== '..' && !desktopRelative.startsWith('..' + path.sep) && !path.isAbsolute(desktopRelative)) {
    return `desktop/${desktopRelative.split(path.sep).join('/')}`;
  }
  return path.relative(PROJECT_ROOT, filePath).split(path.sep).join('/');
}

function limitDocumentText(text) {
  const value = String(text ?? '');
  return value.length > MAX_DOCUMENT_CHARS
    ? { content: value.slice(0, MAX_DOCUMENT_CHARS), truncated: true }
    : { content: value, truncated: false };
}

function writeUtf8Document(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(content ?? ''), 'utf8');
}

function readTextDocument(rawPath) {
  const filePath = resolveDocumentPath(rawPath, 'text');
  const text = fs.readFileSync(filePath, 'utf8');
  const limited = limitDocumentText(text);
  return {
    ok: true,
    filePath: documentResultPath(filePath),
    content: limited.content,
    truncated: limited.truncated,
    bytes: fs.statSync(filePath).size
  };
}

async function openTextDocumentInNotepad(rawPath) {
  const filePath = resolveDocumentPath(rawPath, 'text');
  const encodedPath = Buffer.from(filePath, 'utf8').toString('base64');
  const command = `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
Start-Process -FilePath 'notepad.exe' -ArgumentList @($path)
@{ ok = $true } | ConvertTo-Json -Compress`;
  try {
    await runPowerShell(command, 15000);
  } catch (error) {
    throw new Error(`启动记事本失败：${String(error.stderr || error.message || '').trim().slice(0, 400)}`);
  }
  // Start-Process returns before the GUI has painted. Reuse the same native
  // window activation verification as the regular application launcher.
  const activated = await activateApplicationWindow('notepad', path.basename(filePath));
  if (!activated.ok) throw new Error('文件已存在，但没有找到可显示的记事本窗口。');
  return { ok: true, filePath: documentResultPath(filePath), notepadOpened: true };
}

async function writeTextDocument(rawPath, content, mode = 'replace', openInNotepad = false) {
  const normalizedMode = ['create', 'replace', 'append', 'prepend'].includes(String(mode || '').toLowerCase())
    ? String(mode || '').toLowerCase()
    : 'replace';
  const filePath = resolveDocumentPath(rawPath, 'text', { mustExist: normalizedMode !== 'create' && normalizedMode !== 'replace' });
  const existedBefore = fs.existsSync(filePath);
  if (normalizedMode === 'create' && existedBefore) throw new Error('文件已存在；如需覆盖请明确使用 replace。');
  if (String(content ?? '').length > MAX_DOCUMENT_CHARS) throw new Error('写入内容超过 160000 个字符。');
  let next = String(content ?? '');
  if (normalizedMode === 'append' || normalizedMode === 'prepend') {
    const current = fs.readFileSync(filePath, 'utf8');
    next = normalizedMode === 'append' ? current + next : next + current;
  }
  if (Buffer.byteLength(next, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('写入后文档超过 5 MB。');
  writeUtf8Document(filePath, next);
  // Verify the bytes on disk before reporting success.  This prevents a
  // friendly model response from masking a failed/partial Notepad write.
  const persisted = fs.readFileSync(filePath, 'utf8');
  if (persisted !== next) throw new Error('文本文档写入校验失败，文件内容未按预期保存。');
  if (!existedBefore) lastCreatedDocumentPath = documentResultPath(filePath);
  let notepadOpened = false;
  let notepadError = '';
  if (openInNotepad === true) {
    try {
      await openTextDocumentInNotepad(filePath);
      notepadOpened = true;
    } catch (error) {
      notepadError = error.message;
    }
  }
  return { ok: true, filePath: documentResultPath(filePath), mode: normalizedMode, notepadOpened, notepadError, message: `已写入文本文档：${documentResultPath(filePath)}` };
}

function getLastCreatedDocumentPath() {
  return lastCreatedDocumentPath;
}

function editTextDocument(rawPath, oldText, newText, replaceAll = true) {
  const filePath = resolveDocumentPath(rawPath, 'text');
  const oldValue = String(oldText ?? '');
  if (!oldValue) throw new Error('old_text 不能为空，编辑必须指定要替换的原文。');
  const current = fs.readFileSync(filePath, 'utf8');
  if (!current.includes(oldValue)) throw new Error('文档中没有找到要替换的精确文本，未做修改。');
  const replacement = String(newText ?? '');
  let count = 0;
  let next;
  if (replaceAll !== false) {
    count = current.split(oldValue).length - 1;
    next = current.split(oldValue).join(replacement);
  } else {
    const index = current.indexOf(oldValue);
    next = current.slice(0, index) + replacement + current.slice(index + oldValue.length);
    count = 1;
  }
  if (Buffer.byteLength(next, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('编辑后文档超过 5 MB。');
  writeUtf8Document(filePath, next);
  const persisted = fs.readFileSync(filePath, 'utf8');
  if (persisted !== next) throw new Error('文本文档编辑校验失败，文件内容未按预期保存。');
  return { ok: true, filePath: documentResultPath(filePath), replacements: count, message: `已编辑文本文档：${documentResultPath(filePath)}` };
}

function encodePowerShellText(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

async function readWordDocument(rawPath) {
  const filePath = resolveDocumentPath(rawPath, 'word');
  const pathBase64 = encodePowerShellText(filePath);
  const command = `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}'))
$word = $null; $doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false; $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($path, $false, $true)
  $text = [string]$doc.Content.Text
  @{ ok = $true; content = $text } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $doc) { $doc.Close($false) | Out-Null }
  if ($null -ne $word) { $word.Quit() | Out-Null }
}`;
  try {
    const { stdout } = await runPowerShell(command, 60000);
    const result = parsePowerShellJson(stdout, null);
    if (!result?.ok) throw new Error('Word 未返回文档内容。');
    const limited = limitDocumentText(result.content);
    return { ok: true, filePath: documentResultPath(filePath), content: limited.content, truncated: limited.truncated, bytes: fs.statSync(filePath).size };
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    throw new Error(`读取 Word 文档失败：${detail || '请确认已安装 Microsoft Word 且文件未被占用。'}`);
  }
}

async function createWordDocument(rawPath, content) {
  const filePath = resolveDocumentPath(rawPath, 'word', { mustExist: false });
  if (fs.existsSync(filePath)) throw new Error('Word 文件已存在；为避免覆盖，请换一个文件名。');
  const text = String(content ?? '');
  if (text.length > MAX_DOCUMENT_CHARS) throw new Error('写入内容超过 160000 个字符。');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const pathBase64 = encodePowerShellText(filePath);
  const contentBase64 = encodePowerShellText(text);
  const command = `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}'))
$content = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${contentBase64}'))
$word = $null; $doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false; $word.DisplayAlerts = 0
  $doc = $word.Documents.Add()
  $doc.Content.Text = $content
  $doc.SaveAs2($path, 16)
  @{ ok = $true } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $doc) { $doc.Close($false) | Out-Null }
  if ($null -ne $word) { $word.Quit() | Out-Null }
}`;
  try {
    await runPowerShell(command, 60000);
    if (!fs.existsSync(filePath)) throw new Error('Word 文件未生成。');
    return { ok: true, filePath: documentResultPath(filePath), message: `已创建 Word 文档：${documentResultPath(filePath)}` };
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    throw new Error(`创建 Word 文档失败：${detail || '请确认已安装 Microsoft Word。'}`);
  }
}

async function editWordDocument(rawPath, oldText, newText, replaceAll = true) {
  const filePath = resolveDocumentPath(rawPath, 'word');
  const oldValue = String(oldText ?? '');
  if (!oldValue) throw new Error('old_text 不能为空，编辑必须指定要替换的原文。');
  const pathBase64 = encodePowerShellText(filePath);
  const oldBase64 = encodePowerShellText(oldValue);
  const newBase64 = encodePowerShellText(String(newText ?? ''));
  const replaceMode = replaceAll !== false ? '$true' : '$false';
  const command = `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}'))
$old = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${oldBase64}'))
$new = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${newBase64}'))
$replaceAll = ${replaceMode}
$word = $null; $doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false; $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($path, $false, $false)
  $full = [string]$doc.Content.Text
  $index = $full.IndexOf($old, [StringComparison]::Ordinal)
  if ($index -lt 0) { throw '文档中没有找到要替换的精确文本，未做修改。' }
  if ($replaceAll) {
    $count = ([regex]::Matches($full, [regex]::Escape($old))).Count
    $updated = $full.Replace($old, $new)
  } else {
    $count = 1
    $updated = $full.Substring(0, $index) + $new + $full.Substring($index + $old.Length)
  }
  $doc.Content.Text = $updated
  $doc.Save()
  @{ ok = $true; replacements = $count } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $doc) { $doc.Close($false) | Out-Null }
  if ($null -ne $word) { $word.Quit() | Out-Null }
}`;
  try {
    const { stdout } = await runPowerShell(command, 60000);
    const result = parsePowerShellJson(stdout, null);
    if (!result?.ok) throw new Error('Word 未返回编辑结果。');
    return { ok: true, filePath: documentResultPath(filePath), replacements: Number(result.replacements) || 1, message: `已编辑 Word 文档：${documentResultPath(filePath)}` };
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    throw new Error(`编辑 Word 文档失败：${detail || '请确认已安装 Microsoft Word 且文件未被占用。'}`);
  }
}

async function findWeChatWindows() {
  const command = `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ListAgentWindowApi {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
}
'@
$processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(WeChat|Weixin)$' })
$items = New-Object System.Collections.Generic.List[object]
$callback = [ListAgentWindowApi+EnumWindowsProc]{ param($handle, $unused)
  $processId = [uint32]0
  [ListAgentWindowApi]::GetWindowThreadProcessId($handle, [ref]$processId) | Out-Null
  $process = $processes | Where-Object { $_.Id -eq [int]$processId } | Select-Object -First 1
  if ($null -eq $process) { return $true }
  $titleBuilder = New-Object Text.StringBuilder 512
  [ListAgentWindowApi]::GetWindowText($handle, $titleBuilder, 512) | Out-Null
  if ($titleBuilder.Length -eq 0) { return $true }
  $rect = New-Object ListAgentWindowApi+RECT
  [ListAgentWindowApi]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $items.Add([pscustomobject]@{
    handle = $handle.ToInt64()
    processId = $process.Id
    process = $process.ProcessName
    title = $titleBuilder.ToString()
    visible = [ListAgentWindowApi]::IsWindowVisible($handle)
    minimized = [ListAgentWindowApi]::IsIconic($handle)
    x = $rect.Left
    y = $rect.Top
    width = [Math]::Max(0, $rect.Right - $rect.Left)
    height = [Math]::Max(0, $rect.Bottom - $rect.Top)
  })
  return $true
}
[ListAgentWindowApi]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
if ($items.Count -eq 0) {
  # Some older clients expose MainWindowHandle only after their first repaint.
  # Keep the original process-level fallback for that transition.
  $items = @($processes | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
    $handle = [IntPtr]$_.MainWindowHandle
    $rect = New-Object ListAgentWindowApi+RECT
    [ListAgentWindowApi]::GetWindowRect($handle, [ref]$rect) | Out-Null
    [pscustomobject]@{
      handle = $handle.ToInt64(); processId = $_.Id; process = $_.ProcessName; title = $_.MainWindowTitle
      visible = [ListAgentWindowApi]::IsWindowVisible($handle); minimized = [ListAgentWindowApi]::IsIconic($handle)
      x = $rect.Left; y = $rect.Top; width = [Math]::Max(0, $rect.Right - $rect.Left); height = [Math]::Max(0, $rect.Bottom - $rect.Top)
    }
  })
}
$outputItems = @($items | ForEach-Object { $_ })
$outputItems | ConvertTo-Json -Compress`;
  let output;
  try {
    output = await runPowerShell(command);
  } catch (error) {
    throw new Error(`微信窗口枚举失败：${String(error.stderr || error.message).trim().slice(0, 500)}`);
  }
  const { stdout } = output;
  const parsed = parsePowerShellJson(stdout, []);
  return Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
}

async function focusWeChatWindow(handle) {
  const numericHandle = Number(handle);
  if (!Number.isSafeInteger(numericHandle) || numericHandle <= 0) throw new Error('微信窗口句柄无效。');
  const command = `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ListAgentFocusApi {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
$handle = [IntPtr]${numericHandle}
[ListAgentFocusApi]::ShowWindow($handle, 9) | Out-Null
[ListAgentFocusApi]::SetForegroundWindow($handle) | Out-Null
@{ ok = $true } | ConvertTo-Json -Compress`;
  let output;
  try {
    output = await runPowerShell(command);
  } catch (error) {
    throw new Error(`微信窗口置前脚本失败：${String(error.stderr || error.message).trim().slice(0, 500)}`);
  }
  const { stdout } = output;
  return parsePowerShellJson(stdout, { ok: true });
}

async function focusFirstWeChatWindow() {
  const windows = await findWeChatWindows();
  const windowInfo = windows.find((item) => item.visible) || windows[0];
  if (!windowInfo) throw new Error('未找到可用的微信窗口，请先启动微信。');
  await focusWeChatWindow(windowInfo.handle);
  return { ok: true, window: windowInfo };
}

async function captureWeChatWithDesktopCapturer(handle, width, height) {
  try {
    // Ask Electron for a high-resolution thumbnail instead of using the
    // window's logical/DIP size. On a scaled display the latter can be much
    // smaller than the actual pixels, which makes short Chinese messages
    // unreadable to the vision model. The returned PNG and YOLO coordinates
    // still come from exactly the same image, so resizing cannot desync them.
    const logicalWidth = Math.max(1, Number(width) || 1280);
    const logicalHeight = Math.max(1, Number(height) || 900);
    const requestedWidth = Math.min(4096, Math.max(1920, Math.round(logicalWidth * 2)));
    const requestedHeight = Math.min(4096, Math.max(1440, Math.round(logicalHeight * 2)));
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: requestedWidth, height: requestedHeight },
      fetchWindowIcons: false
    });
    const handleText = String(handle);
    const source = sources.find((item) => {
      const parts = String(item.id || '').split(':');
      return parts[0] === 'window' && parts[1] === handleText;
    });
    if (!source?.thumbnail || source.thumbnail.isEmpty()) return null;
    const data = source.thumbnail.toPNG();
    if (!data.length) return null;
    return { data, width: source.thumbnail.getSize().width, height: source.thumbnail.getSize().height };
  } catch {
    // Some Windows/Electron combinations do not expose window thumbnails;
    // the native PrintWindow/CopyFromScreen implementation below remains the
    // compatibility fallback.
    return null;
  }
}

async function captureWeChatWindow() {
  let windows = await findWeChatWindows();
  let windowInfo = windows.find((item) => item.visible && item.width > 200 && item.height > 100);
  if (!windowInfo) {
    const restorable = windows.find((item) => item.minimized) || windows[0];
    if (restorable) {
      await focusWeChatWindow(restorable.handle);
      windows = await findWeChatWindows();
      windowInfo = windows.find((item) => item.visible && item.width > 200 && item.height > 100);
    }
  }
  if (!windowInfo) throw new Error('未找到可截图的微信窗口，请先恢复并登录微信。');
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const capturePath = path.join(CAPTURE_DIR, `${Date.now()}-${crypto.randomUUID()}.png`);
  const desktopCapture = await captureWeChatWithDesktopCapturer(windowInfo.handle, windowInfo.width, windowInfo.height);
  if (desktopCapture) {
    fs.writeFileSync(capturePath, desktopCapture.data);
    return {
      ok: true,
      path: capturePath,
      hash: crypto.createHash('sha256').update(desktopCapture.data).digest('hex'),
      base64: desktopCapture.data.toString('base64'),
      width: desktopCapture.width,
      height: desktopCapture.height,
      captureMethod: 'electron-desktop-capturer'
    };
  }

  const pathBase64 = Buffer.from(capturePath, 'utf8').toString('base64');
  const command = `Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ListAgentCaptureApi {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
}
'@
[ListAgentCaptureApi]::SetProcessDPIAware() | Out-Null
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}'))
$handle = [IntPtr]${Number(windowInfo.handle)}
$rect = New-Object ListAgentCaptureApi+RECT
if (-not [ListAgentCaptureApi]::GetWindowRect($handle, [ref]$rect)) { throw '无法读取微信窗口尺寸。' }
$width = [Math]::Max(1, $rect.Right - $rect.Left)
$height = [Math]::Max(1, $rect.Bottom - $rect.Top)
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
$printed = [ListAgentCaptureApi]::PrintWindow($handle, $hdc, 2)
$graphics.ReleaseHdc($hdc)
if (-not $printed) { $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height))) }
$bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
if (-not [IO.File]::Exists($target)) { throw '截图文件未生成。' }
@{ ok = $true; path = $target; exists = [IO.File]::Exists($target); width = ${Number(windowInfo.width)}; height = ${Number(windowInfo.height)} } | ConvertTo-Json -Compress`;
  let output;
  try {
    output = await runPowerShell(command);
  } catch (error) {
    throw new Error(`微信窗口截图脚本失败：${String(error.stderr || error.message).trim().slice(0, 500)}`);
  }
  const { stdout } = output;
  const result = parsePowerShellJson(stdout, null);
  if (!result?.ok || !fs.existsSync(capturePath)) throw new Error(`微信窗口截图失败：${JSON.stringify(result || {})}`);
  const data = fs.readFileSync(capturePath);
  let actualSize = { width: 0, height: 0 };
  try { actualSize = nativeImage.createFromBuffer(data).getSize(); } catch { /* keep the window-reported fallback size */ }
  return {
    ...result,
    path: capturePath,
    hash: crypto.createHash('sha256').update(data).digest('hex'),
    base64: data.toString('base64'),
    width: actualSize.width || Number(result.width) || 0,
    height: actualSize.height || Number(result.height) || 0,
    captureMethod: 'powershell-print-window'
  };
}

async function captureDesktopWithDesktopCapturer() {
  try {
    // The PowerShell implementation below captures the complete virtual
    // desktop. Electron is kept as a compatibility fallback for environments
    // where CopyFromScreen is unavailable (for example a restricted session).
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      // Request a large lossless thumbnail. Electron returns the best size it
      // can provide for the display, so do not resize the resulting PNG.
      thumbnailSize: { width: 7680, height: 4320 },
      fetchWindowIcons: false
    });
    const source = sources.find((item) => item?.thumbnail && !item.thumbnail.isEmpty());
    if (!source?.thumbnail) return null;
    const data = source.thumbnail.toPNG();
    if (!data.length) return null;
    const size = source.thumbnail.getSize();
    return {
      data,
      width: size.width,
      height: size.height,
      displayId: source.display_id || ''
    };
  } catch {
    return null;
  }
}

async function captureDesktopWithPowerShell(capturePath) {
  const pathBase64 = Buffer.from(capturePath, 'utf8').toString('base64');
  const command = `Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ListAgentDesktopCaptureApi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@
[ListAgentDesktopCaptureApi]::SetProcessDPIAware() | Out-Null
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}'))
# SM_X/Y/VIRTUALSCREEN and SM_CX/CY/VIRTUALSCREEN describe every monitor.
$left = [ListAgentDesktopCaptureApi]::GetSystemMetrics(76)
$top = [ListAgentDesktopCaptureApi]::GetSystemMetrics(77)
$width = [Math]::Max(1, [ListAgentDesktopCaptureApi]::GetSystemMetrics(78))
$height = [Math]::Max(1, [ListAgentDesktopCaptureApi]::GetSystemMetrics(79))
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size($width, $height)), [System.Drawing.CopyPixelOperation]::SourceCopy)
  $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
@{ ok = $true; x = $left; y = $top; width = $width; height = $height } | ConvertTo-Json -Compress`;
  const output = await runPowerShell(command, 30000);
  return parsePowerShellJson(output.stdout, null);
}

async function captureDesktopScreen() {
  fs.mkdirSync(DESKTOP_CAPTURE_DIR, { recursive: true });
  const capturePath = path.join(DESKTOP_CAPTURE_DIR, `${Date.now()}-${crypto.randomUUID()}.png`);

  // CopyFromScreen gives a pixel-for-pixel capture of the whole virtual
  // desktop, including multiple monitors and windows that are not owned by
  // Electron. Prefer it so the vision model receives the complete display.
  try {
    const result = await captureDesktopWithPowerShell(capturePath);
    if (result?.ok && fs.existsSync(capturePath)) {
      const data = fs.readFileSync(capturePath);
      let actualSize = { width: 0, height: 0 };
      try { actualSize = nativeImage.createFromBuffer(data).getSize(); } catch { /* use PowerShell dimensions */ }
      return {
        ok: true,
        path: capturePath,
        hash: crypto.createHash('sha256').update(data).digest('hex'),
        base64: data.toString('base64'),
        width: actualSize.width || Number(result.width) || 0,
        height: actualSize.height || Number(result.height) || 0,
        virtualX: Number(result.x) || 0,
        virtualY: Number(result.y) || 0,
        captureMethod: 'powershell-copy-from-screen'
      };
    }
  } catch {
    // Fall through to Electron's screen source below.
  }

  const desktopCapture = await captureDesktopWithDesktopCapturer();
  if (!desktopCapture) {
    throw new Error('无法截取当前桌面，请确认 Windows 桌面处于解锁状态后重试。');
  }
  fs.writeFileSync(capturePath, desktopCapture.data);
  return {
    ok: true,
    path: capturePath,
    hash: crypto.createHash('sha256').update(desktopCapture.data).digest('hex'),
    base64: desktopCapture.data.toString('base64'),
    width: desktopCapture.width,
    height: desktopCapture.height,
    displayId: desktopCapture.displayId,
    captureMethod: 'electron-screen-capturer'
  };
}

async function getWeChatStatus() {
  const command = "$items = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(WeChat|Weixin)$' } | ForEach-Object { $_.ProcessName }); @{ running = ($items.Count -gt 0); processes = $items } | ConvertTo-Json -Compress";
  const { stdout } = await runPowerShell(command);
  try {
    const status = JSON.parse(stdout.trim());
    status.windows = await findWeChatWindows();
    return status;
  } catch {
    return { running: false, processes: [], windows: [] };
  }
}

function normalizeApplicationName(value) {
  const raw = String(value || '').trim().toLowerCase();
  const aliases = {
    notepad: 'notepad',
    'notepad.exe': 'notepad',
    '记事本': 'notepad',
    calculator: 'calculator',
    calc: 'calculator',
    'calc.exe': 'calculator',
    '计算器': 'calculator',
    explorer: 'explorer',
    'explorer.exe': 'explorer',
    'file explorer': 'explorer',
    '文件资源管理器': 'explorer',
    '资源管理器': 'explorer',
    settings: 'settings',
    'ms-settings:': 'settings',
    '系统设置': 'settings',
    '设置': 'settings',
    wechat: 'wechat',
    weixin: 'wechat',
    '微信': 'wechat'
  };
  return aliases[raw] || raw;
}

async function launchStartMenuApplication(app) {
  const namesByApp = {
    notepad: ['记事本', 'Notepad'],
    calculator: ['计算器', 'Calculator'],
    explorer: ['文件资源管理器', 'File Explorer'],
    settings: ['设置', 'Settings'],
    wechat: ['微信', 'WeChat', 'Weixin'],
    chrome: ['Google Chrome', 'Chrome'],
    edge: ['Microsoft Edge', 'Edge'],
    qq: ['QQ'],
    steam: ['Steam'],
    discord: ['Discord'],
    vscode: ['Visual Studio Code', 'VS Code']
  };
  const names = namesByApp[app] || ([app].filter((value) => value && value.length <= 80 && !/[\\/:"']/u.test(value)));
  if (!names.length) return null;
  const encodedNames = Buffer.from(JSON.stringify(names), 'utf8').toString('base64');
  const command = `$names = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedNames}')) | ConvertFrom-Json
$entry = @(Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.Name } | Select-Object -First 1)[0]
if ($null -eq $entry) { @{ ok = $false } | ConvertTo-Json -Compress; exit }
$appId = [string]$entry.AppID
if ($appId -match '^[A-Za-z]:\\\\' -and (Test-Path -LiteralPath $appId)) {
  Start-Process -FilePath $appId -WorkingDirectory (Split-Path -Parent $appId)
} elseif ($appId -match '^[^!]+![^!]+$') {
  Start-Process -FilePath 'explorer.exe' -ArgumentList @("shell:AppsFolder\\$appId")
} else {
  Start-Process -FilePath $appId
}
@{ ok = $true; name = [string]$entry.Name; appId = $appId } | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await runPowerShell(command);
    const result = parsePowerShellJson(stdout, null);
    return result?.ok === true ? result : null;
  } catch {
    return null;
  }
}

async function activateWeChatWindow() {
  // 微信的新版本可能把真正的窗口托管在 ApplicationFrameHost，
  // 因此不能依赖 Weixin.exe 的 MainWindowHandle 或 WScript AppActivate。
  return activateApplicationWindow('wechat');
}

async function activateApplicationWindow(app, extraTitle = '') {
  const titlesByApp = {
    notepad: ['记事本', 'Notepad'],
    calculator: ['计算器', 'Calculator'],
    explorer: ['文件资源管理器', 'File Explorer'],
    settings: ['设置', 'Settings'],
    chrome: ['Google Chrome', 'Chrome'],
    edge: ['Microsoft Edge', 'Edge'],
    wechat: ['微信', 'WeChat', 'Weixin'],
    qq: ['QQ'],
    steam: ['Steam'],
    discord: ['Discord'],
    vscode: ['Visual Studio Code', 'VS Code']
  };
  const titles = [...new Set([extraTitle, ...(titlesByApp[app] || [app])].filter(Boolean))];
  const encodedTitles = Buffer.from(JSON.stringify(titles), 'utf8').toString('base64');
  const command = `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ListAgentApplicationApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
$titles = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTitles}')) | ConvertFrom-Json
$found = [IntPtr]::Zero
$matched = ''
# UWP/微信首次启动可能需要十几秒；持续轮询窗口而不是只看进程。
1..100 | ForEach-Object {
  if ($found -eq [IntPtr]::Zero) {
    [ListAgentApplicationApi]::EnumWindows({ param($hWnd, $lParam)
      if (-not [ListAgentApplicationApi]::IsWindowVisible($hWnd)) { return $true }
      $text = New-Object Text.StringBuilder 512
      [ListAgentApplicationApi]::GetWindowText($hWnd, $text, $text.Capacity) | Out-Null
      foreach ($title in $titles) {
        if ($text.ToString().IndexOf([string]$title, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
          $script:found = $hWnd; $script:matched = [string]$title; return $false
        }
      }
      return $true
    }, [IntPtr]::Zero) | Out-Null
  }
  if ($found -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 }
}
$active = $false
if ($found -ne [IntPtr]::Zero) {
  [ListAgentApplicationApi]::ShowWindow($found, 9) | Out-Null
  # Windows may deny foreground focus to a background process even though the
  # window is visible; finding and restoring the window still proves launch.
  [ListAgentApplicationApi]::SetForegroundWindow($found) | Out-Null
  $active = $true
}
@{ ok = [bool]$active; title = $matched; handle = $found.ToInt64() } | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await runPowerShell(command);
    return parsePowerShellJson(stdout, { ok: false });
  } catch {
    return { ok: false };
  }
}

async function openApplication(app) {
  const normalizedApp = normalizeApplicationName(app);
  const commands = {
    notepad: ['notepad.exe'],
    calculator: ['calc.exe'],
    explorer: ['explorer.exe'],
    settings: ['cmd.exe', ['/d', '/s', '/c', 'start "" "ms-settings:"']],
    wechat: ['cmd.exe', ['/d', '/s', '/c', 'start "" "weixin:"']]
  };
  const definition = commands[normalizedApp];
  const startMenuResult = await launchStartMenuApplication(normalizedApp);
  if (startMenuResult) {
    if (normalizedApp === 'wechat') {
      const activated = await activateWeChatWindow();
      if (!activated.ok) throw new Error('微信进程已启动，但没有找到可显示的微信窗口。');
    } else {
      const activated = await activateApplicationWindow(normalizedApp, startMenuResult.name);
      if (!activated.ok) throw new Error(`${normalizedApp}进程已启动，但没有找到可显示的应用窗口。`);
    }
    // Do not echo the localized Start Apps name: PowerShell's legacy console
    // encoding can turn Chinese text into mojibake when it crosses stdout.
    return { ok: true, message: `已打开：${normalizedApp}` };
  }
  if (!definition) throw new Error('未在 Windows 开始菜单中找到该应用；为安全起见不会执行任意路径。');
  const [command, args = []] = definition;
  await new Promise((resolve, reject) => {
    // Do not hide GUI launches: some Windows desktop/UWP bridges inherit the
    // hidden flag and leave Notepad/Calculator running without a visible view.
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
  if (normalizedApp === 'wechat') {
    const activated = await activateWeChatWindow();
    if (!activated.ok) throw new Error('微信进程已启动，但没有找到可显示的微信窗口。');
  } else {
    const activated = await activateApplicationWindow(normalizedApp);
    if (!activated.ok) throw new Error(`${normalizedApp}进程已启动，但没有找到可显示的应用窗口。`);
  }
  return { ok: true, message: `已请求打开：${normalizedApp}` };
}

async function openUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('网页地址格式不正确。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只允许打开 HTTP 或 HTTPS 网页。');
  await shell.openExternal(parsed.href);
  return { ok: true, message: `已在默认浏览器打开 ${parsed.href}` };
}

async function sendTextToActiveWeChat(rawText, shouldSend = true) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text || text.length > 2000) throw new Error('微信消息不能为空，且长度不能超过 2000 个字符。');
  // 先通过窗口句柄恢复微信；WScript AppActivate 对新版微信经常失效，
  // 尤其是窗口由 ApplicationFrameHost 或隐藏主进程托管时。
  await focusFirstWeChatWindow();
  const payload = Buffer.from(text, 'utf16le').toString('base64');
  const enter = shouldSend === false ? '' : "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')";
  const command = `Add-Type -AssemblyName System.Windows.Forms\n$t = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${payload}'))\n$old = Get-Clipboard -Raw -ErrorAction SilentlyContinue\nSet-Clipboard -Value $t\nStart-Sleep -Milliseconds 180\n[System.Windows.Forms.SendKeys]::SendWait('^v')\nStart-Sleep -Milliseconds 240\n${enter}\nStart-Sleep -Milliseconds 180\nif ($null -ne $old) { Set-Clipboard -Value $old }`;
  await runPowerShell(command);
  return { ok: true, message: shouldSend === false ? '文字已粘贴到微信输入框。' : '已粘贴并按 Enter 发送微信消息。' };
}

async function executeTool(name, args, automationEnabled) {
  if (!automationEnabled && !READ_ONLY_TOOLS.has(name)) throw new Error('电脑操作尚未启用。请先在“自动化”页面开启它。');
  switch (name) {
    case 'get_current_time':
      return getCurrentTime();
    case 'get_system_location':
      return getSystemLocation();
    case 'get_weather':
      return getWeather(args.location);
    case 'search_web':
      return searchWeb(args.query, args.limit);
    case 'open_url':
      return openUrl(args.url);
    case 'open_application':
      return openApplication(args.app || args.application || args.name || args.program);
    case 'focus_wechat':
      return focusFirstWeChatWindow();
    case 'capture_wechat_window':
      {
        const capture = await captureWeChatWindow();
        return {
          ok: true,
          path: capture.path,
          hash: capture.hash,
          width: capture.width,
          height: capture.height,
          captureMethod: capture.captureMethod,
          __wechatImageBase64: capture.base64
        };
      }
    case 'capture_desktop_screen':
      {
        const capture = await captureDesktopScreen();
        return {
          ok: true,
          path: capture.path,
          hash: capture.hash,
          width: capture.width,
          height: capture.height,
          virtualX: capture.virtualX,
          virtualY: capture.virtualY,
          displayId: capture.displayId,
          captureMethod: capture.captureMethod,
          __desktopImageBase64: capture.base64
        };
      }
    case 'get_wechat_status':
      return getWeChatStatus();
    case 'send_text_to_active_wechat':
      return sendTextToActiveWeChat(args.text, args.send);
    case 'read_text_document':
      return readTextDocument(args.file_path || args.path || args.filename);
    case 'open_text_document_in_notepad':
      return openTextDocumentInNotepad(args.file_path || args.path || args.filename);
    case 'write_text_document':
      return writeTextDocument(args.file_path || args.path || args.filename, args.content, args.mode, args.open_in_notepad);
    case 'edit_text_document':
      return editTextDocument(args.file_path || args.path || args.filename, args.old_text, args.new_text, args.replace_all);
    case 'read_word_document':
      return readWordDocument(args.file_path || args.path || args.filename);
    case 'create_word_document':
      return createWordDocument(args.file_path || args.path || args.filename, args.content);
    case 'edit_word_document':
      return editWordDocument(args.file_path || args.path || args.filename, args.old_text, args.new_text, args.replace_all);
    default:
      throw new Error('不支持的工具请求。');
  }
}

function describeToolCall(name, args) {
  if (name === 'get_current_time') return '读取当前系统时间';
  if (name === 'get_system_location') return '读取当前网络大致位置';
  if (name === 'get_weather') return `查询天气：${args.location || '当前位置'}`;
  if (name === 'search_web') return `联网搜索：${String(args.query || '（缺少关键词）').slice(0, 120)}`;
  if (name === 'open_url') return `在默认浏览器打开：${args.url || '（缺少地址）'}`;
  if (name === 'open_application') return `打开应用：${args.app || args.application || args.name || args.program || '（未知）'}`;
  if (name === 'focus_wechat') return '恢复并置前微信窗口';
  if (name === 'capture_wechat_window') return '截取当前微信窗口供模型识别';
  if (name === 'capture_desktop_screen') return '截取整个桌面供视觉模型识别';
  if (name === 'get_wechat_status') return '检查微信是否正在运行（不读取消息）';
  if (name === 'send_text_to_active_wechat') return `${args.send === false ? '粘贴到' : '发送至'}当前微信窗口：${String(args.text || '').slice(0, 120)}`;
  if (name === 'read_text_document') return `读取文本文档：${args.file_path || args.path || '（缺少路径）'}`;
  if (name === 'open_text_document_in_notepad') return `用记事本打开：${args.file_path || args.path || '（缺少路径）'}`;
  if (name === 'write_text_document') return `写入文本文档（需确认）：${args.file_path || args.path || '（缺少路径）'}`;
  if (name === 'edit_text_document') return `编辑文本文档（需确认）：${args.file_path || args.path || '（缺少路径）'}`;
  if (name === 'read_word_document') return `读取 Word 文档：${args.file_path || args.path || '（缺少路径）'}`;
  if (name === 'create_word_document') return `创建 Word 文档（需确认）：${args.file_path || args.path || '（缺少路径）'}`;
  if (name === 'edit_word_document') return `编辑 Word 文档（需确认）：${args.file_path || args.path || '（缺少路径）'}`;
  return '执行未识别操作';
}

module.exports = {
  TOOL_DEFINITIONS,
  describeToolCall,
  executeTool,
  getWeChatStatus,
  findWeChatWindows,
  focusFirstWeChatWindow,
  captureWeChatWindow,
  captureDesktopScreen,
  sendTextToActiveWeChat,
  normalizeApplicationName,
  getCurrentTime,
  getSystemLocation,
  getWeather,
  searchWeb,
  READ_ONLY_TOOLS,
  CONFIRMATION_REQUIRED_TOOLS,
  resolveDocumentPath,
  readTextDocument,
  openTextDocumentInNotepad,
  getLastCreatedDocumentPath,
  writeTextDocument,
  editTextDocument,
  readWordDocument,
  createWordDocument,
  editWordDocument
};
