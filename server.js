const http = require('http');
const { CoderModel } = require('./model.js');
const { GitHubCrawler } = require('./github-crawler.js');

const PORT = process.env.PORT || 3000;
const model = new CoderModel({ hiddenSize: 64, lr: 0.02 });

// Пытаемся восстановить модель из файла
const loaded = model.loadFromFile('./model_checkpoint.json');
if (!loaded) {
  const initialCorpus = `
function add(a, b) { return a + b; }
const multiply = (x, y) => x * y;
def calculate(x, y):
    return x + y
`;
  model.initVocab(initialCorpus);
  model.trainOnCode("const add = (a, b) => a + b;\n", "js", 20, 10);
  model.trainOnCode("def add(a, b):\n    return a + b\n", "py", 20, 10);
}

const crawler = new GitHubCrawler(model, {
  intervalMs: Number(process.env.INTERVAL_MS) || 15000,
  token: process.env.GITHUB_TOKEN || null
});

// Сохранение при корректном завершении процесса
process.on('SIGINT', () => {
  console.log('\n[Server] Завершение работы, сохраняем чекпоинт...');
  model.saveToFile();
  process.exit(0);
});

function parseJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Autonomous Coder AI</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; }
    body { max-width: 900px; margin: 0 auto; padding: 24px; }
    .card { background: #1e293b; border-radius: 8px; padding: 18px; margin-bottom: 16px; border: 1px solid #334155; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .stat { background: #0f172a; padding: 12px; border-radius: 6px; text-align: center; }
    .stat-val { font-size: 20px; font-weight: bold; color: #38bdf8; }
    .stat-lbl { font-size: 11px; color: #94a3b8; text-transform: uppercase; margin-top: 4px; }
    textarea, input, select, button { width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid #475569; color: #fff; border-radius: 6px; padding: 8px; font-family: monospace; }
    button { background: #2563eb; color: #fff; font-weight: bold; cursor: pointer; border: none; padding: 10px; margin-top: 8px; }
    button:hover { background: #1d4ed8; }
    pre { background: #0f172a; padding: 12px; border-radius: 6px; overflow-x: auto; color: #a5f3fc; }
    .row { display: flex; gap: 8px; margin-bottom: 8px; }
    .badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; background: #334155; }
    .badge-on { background: #166534; color: #bbf7d0; }
    .log-box { background: #0b1120; border: 1px solid #334155; border-radius: 6px; padding: 10px; height: 160px; overflow-y: auto; font-family: monospace; font-size: 12px; }
    .log-info { color: #94a3b8; }
    .log-success { color: #4ade80; }
    .log-warn { color: #facc15; }
    .log-error { color: #f87171; }
  </style>
</head>
<body>
  <h2>Autonomous Coder AI (Python & JavaScript)</h2>
  <div class="card">
    <div class="row" style="justify-content: space-between; align-items: center;">
      <h4>Мониторинг</h4>
      <span id="crawler-badge" class="badge">Обучение GitHub: выключено</span>
    </div>
    <div class="grid">
      <div class="stat"><div class="stat-val" id="stat-vocab">0</div><div class="stat-lbl">Словарь</div></div>
      <div class="stat"><div class="stat-val" id="stat-steps">0</div><div class="stat-lbl">Шаги обучения</div></div>
      <div class="stat"><div class="stat-val" id="stat-loss">0.00</div><div class="stat-lbl">Последний Loss</div></div>
      <div class="stat"><div class="stat-val" id="stat-files">0</div><div class="stat-lbl">Обучено файлов</div></div>
    </div>
    <div class="row" style="margin-top: 12px;">
      <button onclick="toggleCrawler(true)" style="background: #16a34a;">Старт автообучения GitHub</button>
      <button onclick="toggleCrawler(false)" style="background: #dc2626;">Стоп</button>
      <button onclick="saveCheckpoint()" style="background: #475569;">💾 Сохранить чекпоинт</button>
    </div>
  </div>

  <div class="card">
    <h4>Лог работы краулера</h4>
    <div id="log-box" class="log-box">Ожидание событий...</div>
  </div>

  <div class="card">
    <h4>Генерация кода</h4>
    <div class="row">
      <select id="gen-lang" style="max-width: 140px;">
        <option value="python">Python</option>
        <option value="js">JavaScript</option>
      </select>
      <input type="text" id="gen-prompt" value="def calculate(" />
    </div>
    <button onclick="generateCode()">Сгенерировать</button>
    <pre id="gen-output">// Результат</pre>
  </div>

  <div class="card">
    <h4>Ручное дообучение (с проверкой синтаксиса)</h4>
    <div class="row">
      <select id="train-lang" style="max-width: 140px;">
        <option value="python">Python</option>
        <option value="js">JavaScript</option>
      </select>
    </div>
    <textarea id="train-code" rows="4" placeholder="Введите код..."></textarea>
    <button onclick="trainCode()">Обучить</button>
    <div id="train-msg" style="margin-top: 6px; font-size: 13px;"></div>
  </div>

  <script>
    async function update() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        document.getElementById('stat-vocab').innerText = data.model.vocabSize;
        document.getElementById('stat-steps').innerText = data.model.totalSteps;
        document.getElementById('stat-loss').innerText = Number(data.model.recentLoss).toFixed(3);
        document.getElementById('stat-files').innerText = data.crawler.totalProcessed;
        
        const b = document.getElementById('crawler-badge');
        b.className = 'badge ' + (data.crawler.isRunning ? 'badge-on' : '');
        b.innerText = data.crawler.isRunning ? 'Обучение GitHub: активно' : 'Обучение GitHub: выключено';

        const logs = data.crawler.recentLogs || [];
        if (logs.length > 0) {
          document.getElementById('log-box').innerHTML = logs.map(l => 
            \`<div class="log-\${l.type || 'info'}">[\${l.time}] \${l.message}</div>\`
          ).join('');
        }
      } catch (e) {}
    }
    async function generateCode() {
      const lang = document.getElementById('gen-lang').value;
      const prompt = document.getElementById('gen-prompt').value;
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang, prompt, length: 70 })
      });
      const data = await res.json();
      document.getElementById('gen-output').innerText = data.completion;
      update();
    }
    async function trainCode() {
      const lang = document.getElementById('train-lang').value;
      const code = document.getElementById('train-code').value;
      const msg = document.getElementById('train-msg');
      const res = await fetch('/api/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang, code })
      });
      const data = await res.json();
      msg.innerText = data.success ? ('Успешно! Loss: ' + Number(data.loss).toFixed(4)) : ('Ошибка: ' + (data.reason || data.error));
      msg.style.color = data.success ? '#4ade80' : '#f87171';
      update();
    }
    async function toggleCrawler(start) {
      await fetch('/api/crawler/' + (start ? 'start' : 'stop'), { method: 'POST' });
      update();
    }
    async function saveCheckpoint() {
      await fetch('/api/checkpoint/save', { method: 'POST' });
      alert('Чекпоинт успешно сохранен на диск!');
      update();
    }
    setInterval(update, 2500);
    update();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, 'http://localhost:3000');
  const pathname = parsedUrl.pathname;
  const send = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(getDashboardHtml());
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      return send(200, {
        status: 'online',
        model: {
          hiddenSize: model.hiddenSize,
          vocabSize: model.vocabSize,
          totalSteps: model.totalSteps,
          recentLoss: model.recentLoss
        },
        crawler: {
          isRunning: crawler.isRunning,
          totalProcessed: crawler.stats.totalProcessed,
          rejectedSyntax: crawler.stats.rejectedSyntax,
          javascript: crawler.stats.javascript,
          python: crawler.stats.python,
          recentLogs: crawler.stats.recentLogs
        }
      });
    }
    if (req.method === 'POST' && pathname === '/api/generate') {
      const body = await parseJson(req);
      const lang = body.lang || 'python';
      const prompt = body.prompt || (lang === 'python' ? 'def ' : 'function ');
      const completion = model.generate(prompt, lang, Math.min(body.length || 70, 300), body.temperature || 0.7);
      return send(200, { lang, prompt, completion });
    }
    if (req.method === 'POST' && pathname === '/api/train') {
      const body = await parseJson(req);
      if (!body.code) return send(400, { error: 'Поле code обязательно' });
      const result = await crawler.processCode(body.code, body.lang || 'python', 'manual');
      return send(200, result);
    }
    if (req.method === 'POST' && pathname === '/api/checkpoint/save') {
      const ok = model.saveToFile();
      return send(200, { success: ok });
    }
    if (req.method === 'POST' && pathname === '/api/crawler/start') {
      crawler.start();
      return send(200, { message: 'Crawler started' });
    }
    if (req.method === 'POST' && pathname === '/api/crawler/stop') {
      crawler.stop();
      return send(200, { message: 'Crawler stopped' });
    }
    send(404, { error: 'Not found' });
  } catch (e) {
    send(500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});