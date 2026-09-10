const fs = require('fs');
const path = require('path');
const https = require('https');
const { SyntaxValidator } = require('./syntax-validator.js');

class GitHubCrawler {
  constructor(model, options = {}) {
    this.model = model;
    this.token = options.token || process.env.GITHUB_TOKEN || null;
    this.intervalMs = options.intervalMs || 15000;
    this.isRunning = false;
    this.timer = null;
    this.targetLanguages = ['javascript', 'python'];
    this.currentLangIndex = 0;
    this.datasetDir = path.join(process.cwd(), 'dataset');
    if (!fs.existsSync(this.datasetDir)) fs.mkdirSync(this.datasetDir, { recursive: true });

    this.stats = {
      totalProcessed: 0,
      rejectedSyntax: 0,
      javascript: { files: 0, bytes: 0, avgLoss: 0 },
      python: { files: 0, bytes: 0, avgLoss: 0 },
      recentLogs: []
    };
  }

  log(msg, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[Crawler ${timestamp}] [${type.toUpperCase()}] ${msg}`);
    this.stats.recentLogs.unshift({ time: timestamp, type, message: msg });
    if (this.stats.recentLogs.length > 25) this.stats.recentLogs.pop();
  }

  fetchJson(url) {
    return new Promise((resolve, reject) => {
      const headers = {
        'User-Agent': 'Autonomous-Coder-AI',
        'Accept': 'application/vnd.github.v3+json'
      };
      if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

      https.get(url, { headers }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          } else if (res.statusCode === 403) {
            reject(new Error('Превышен лимит запросов GitHub API (Rate Limit 403).'));
          } else {
            reject(new Error(`GitHub API HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
          }
        });
      }).on('error', reject);
    });
  }

  fetchRaw(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Autonomous-Coder-AI' } }, (res) => {
        if (res.statusCode !== 200) return resolve(null);
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', () => resolve(null));
    });
  }

  async processCode(rawCode, lang, source = 'manual') {
    if (!rawCode || rawCode.length < 15 || rawCode.length > 25000) {
      return { success: false, reason: 'Неподходящий размер файла' };
    }
    const lines = rawCode.split('\n');
    if (lines.some(l => l.length > 500)) {
      return { success: false, reason: 'Обнаружен минифицированный код' };
    }

    const isValid = SyntaxValidator.validate(rawCode, lang);
    if (!isValid) {
      this.stats.rejectedSyntax++;
      this.log(`Синтаксическая ошибка в ${source} (${lang}), файл пропущен`, 'warn');
      return { success: false, reason: `Синтаксическая ошибка в ${lang}` };
    }

    // Сохраняем файл в папку dataset/
    try {
      const safeName = source.replace(/[\/\\:]/g, '_');
      const langDir = path.join(this.datasetDir, lang);
      if (!fs.existsSync(langDir)) fs.mkdirSync(langDir, { recursive: true });
      fs.writeFileSync(path.join(langDir, safeName), rawCode);
    } catch (e) {}

    const loss = this.model.trainOnCode(rawCode, lang, 25, 4);
    const langKey = lang.startsWith('py') ? 'python' : 'javascript';
    this.stats.totalProcessed++;
    this.stats[langKey].files++;
    this.stats[langKey].bytes += rawCode.length;
    this.stats[langKey].avgLoss = loss;

    // Автосохранение чекпоинта
    this.model.saveToFile();

    this.log(`Обучено: ${source} (${lang}, ${rawCode.length} байт). Loss: ${loss.toFixed(4)}`, 'success');
    return { success: true, loss, bytes: rawCode.length };
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.log('Автообучение запущено. Начинаем поиск репозиториев...');

    const step = async () => {
      if (!this.isRunning) return;
      const lang = this.targetLanguages[this.currentLangIndex];
      this.currentLangIndex = (this.currentLangIndex + 1) % this.targetLanguages.length;

      try {
        this.log(`Поиск репозиториев на ${lang}...`);
        const query = `language:${lang} stars:>500`;
        const searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=5`;
        const res = await this.fetchJson(searchUrl);

        if (res.items && res.items.length > 0) {
          const repo = res.items[Math.floor(Math.random() * res.items.length)];
          const branch = repo.default_branch || 'main';

          const treeUrl = `https://api.github.com/repos/${repo.full_name}/git/trees/${branch}?recursive=1`;
          const treeData = await this.fetchJson(treeUrl);

          const ext = lang === 'python' ? '.py' : '.js';
          const candidates = (treeData.tree || [])
            .filter(item => item.type === 'blob' && item.path.endsWith(ext) && !item.path.includes('min.') && !item.path.includes('test'));

          if (candidates.length > 0) {
            const chosenFile = candidates[Math.floor(Math.random() * candidates.length)].path;
            this.log(`Загрузка файла: ${repo.full_name}/${chosenFile}`);
            const rawUrl = `https://raw.githubusercontent.com/${repo.full_name}/${branch}/${chosenFile}`;
            const code = await this.fetchRaw(rawUrl);
            if (code) {
              await this.processCode(code, lang, `${repo.full_name}/${chosenFile}`);
            }
          } else {
            this.log(`В репозитории ${repo.full_name} не найдены подходящие ${ext} файлы`, 'warn');
          }
        }
      } catch (err) {
        this.log(`Ошибка: ${err.message}`, 'error');
      }

      if (this.isRunning) {
        this.timer = setTimeout(step, this.intervalMs);
      }
    };

    step();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) clearTimeout(this.timer);
    this.model.saveToFile();
    this.log('Автообучение остановлено. Чекпоинт сохранен.');
  }
}

module.exports = { GitHubCrawler };