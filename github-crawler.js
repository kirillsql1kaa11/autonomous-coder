const https = require('https');
const { SyntaxValidator } = require('./syntax-validator.js');

class GitHubCrawler {
  constructor(model, options = {}) {
    this.model = model;
    this.token = options.token || process.env.GITHUB_TOKEN || null;
    this.intervalMs = options.intervalMs || 25000;
    this.isRunning = false;
    this.timer = null;
    this.targetLanguages = ['javascript', 'python'];
    this.currentLangIndex = 0;
    this.stats = {
      totalProcessed: 0,
      rejectedSyntax: 0,
      javascript: { files: 0, bytes: 0, avgLoss: 0 },
      python: { files: 0, bytes: 0, avgLoss: 0 },
      recentLogs: []
    };
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
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      }).on('error', reject);
    });
  }

  fetchRaw(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Autonomous-Coder-AI' } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }

  async processCode(rawCode, lang, source = 'manual') {
    if (!rawCode || rawCode.length < 15 || rawCode.length > 25000) {
      return { success: false, reason: 'Size out of bounds (min 15, max 25000 chars)' };
    }
    const lines = rawCode.split('\n');
    if (lines.some(l => l.length > 500)) {
      return { success: false, reason: 'Contains minified lines' };
    }

    const isValid = SyntaxValidator.validate(rawCode, lang);
    if (!isValid) {
      this.stats.rejectedSyntax++;
      return { success: false, reason: `Syntax error in ${lang} code` };
    }

    const loss = this.model.trainOnCode(rawCode, lang, 25, 4);
    const langKey = lang.startsWith('py') ? 'python' : 'javascript';
    this.stats.totalProcessed++;
    this.stats[langKey].files++;
    this.stats[langKey].bytes += rawCode.length;
    this.stats[langKey].avgLoss = loss;

    this.stats.recentLogs.unshift({
      timestamp: new Date().toISOString(),
      lang,
      source,
      bytes: rawCode.length,
      loss: Number(loss.toFixed(4))
    });
    if (this.stats.recentLogs.length > 20) this.stats.recentLogs.pop();

    return { success: true, loss, bytes: rawCode.length };
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    const loop = async () => {
      if (!this.isRunning) return;
      const lang = this.targetLanguages[this.currentLangIndex];
      this.currentLangIndex = (this.currentLangIndex + 1) % this.targetLanguages.length;

      try {
        const query = `language:${lang} stars:>200`;
        const searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=5`;
        const res = await this.fetchJson(searchUrl);

        if (res.items && res.items.length > 0) {
          const repo = res.items[Math.floor(Math.random() * res.items.length)];
          const branch = repo.default_branch || 'main';
          const fileToTry = lang === 'python' ? 'main.py' : 'index.js';
          const rawUrl = `https://raw.githubusercontent.com/${repo.full_name}/${branch}/${fileToTry}`;
          const code = await this.fetchRaw(rawUrl);
          await this.processCode(code, lang, `${repo.full_name}/${fileToTry}`);
        }
      } catch (err) {
        this.stats.recentLogs.unshift({ timestamp: new Date().toISOString(), error: err.message });
        if (this.stats.recentLogs.length > 20) this.stats.recentLogs.pop();
      }

      if (this.isRunning) {
        this.timer = setTimeout(loop, this.intervalMs);
      }
    };

    loop();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) clearTimeout(this.timer);
  }
}

module.exports = { GitHubCrawler };
