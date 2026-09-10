const fs = require('fs');

class CoderModel {
  constructor(options = {}) {
    this.hiddenSize = options.hiddenSize || 64;
    this.lr = options.lr || 0.02;
    this.vocab = [];
    this.charToIdx = {};
    this.idxToChar = {};
    this.vocabSize = 0;
    this.totalSteps = 0;
    this.recentLoss = 0;

    this.Wxh = null;
    this.Whh = null;
    this.Why = null;
    this.bh = null;
    this.by = null;

    this.mWxh = null;
    this.mWhh = null;
    this.mWhy = null;
    this.mbh = null;
    this.mby = null;
  }

  saveToFile(filePath = './model_checkpoint.json') {
    if (!this.Wxh) return false;
    try {
      const data = {
        hiddenSize: this.hiddenSize,
        lr: this.lr,
        vocab: this.vocab,
        charToIdx: this.charToIdx,
        idxToChar: this.idxToChar,
        vocabSize: this.vocabSize,
        totalSteps: this.totalSteps,
        recentLoss: this.recentLoss,
        Wxh: this.Wxh.map(row => Array.from(row)),
        Whh: this.Whh.map(row => Array.from(row)),
        Why: this.Why.map(row => Array.from(row)),
        bh: Array.from(this.bh),
        by: Array.from(this.by),
        mWxh: this.mWxh.map(row => Array.from(row)),
        mWhh: this.mWhh.map(row => Array.from(row)),
        mWhy: this.mWhy.map(row => Array.from(row)),
        mbh: Array.from(this.mbh),
        mby: Array.from(this.mby)
      };
      fs.writeFileSync(filePath, JSON.stringify(data));
      console.log(`[Model] Чекпоинт сохранен: ${filePath} (шагов: ${this.totalSteps})`);
      return true;
    } catch (err) {
      console.error('[Model] Ошибка сохранения чекпоинта:', err.message);
      return false;
    }
  }

  loadFromFile(filePath = './model_checkpoint.json') {
    if (!fs.existsSync(filePath)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      this.hiddenSize = data.hiddenSize;
      this.lr = data.lr;
      this.vocab = data.vocab;
      this.charToIdx = data.charToIdx;
      this.idxToChar = data.idxToChar;
      this.vocabSize = data.vocabSize;
      this.totalSteps = data.totalSteps;
      this.recentLoss = data.recentLoss;

      this.Wxh = data.Wxh.map(row => new Float64Array(row));
      this.Whh = data.Whh.map(row => new Float64Array(row));
      this.Why = data.Why.map(row => new Float64Array(row));
      this.bh = new Float64Array(data.bh);
      this.by = new Float64Array(data.by);

      this.mWxh = data.mWxh.map(row => new Float64Array(row));
      this.mWhh = data.mWhh.map(row => new Float64Array(row));
      this.mWhy = data.mWhy.map(row => new Float64Array(row));
      this.mbh = new Float64Array(data.mbh);
      this.mby = new Float64Array(data.mby);
      console.log(`[Model] Чекпоинт загружен: ${filePath} (шагов: ${this.totalSteps}, словарь: ${this.vocabSize})`);
      return true;
    } catch (err) {
      console.error('[Model] Ошибка загрузки чекпоинта:', err.message);
      return false;
    }
  }

  initVocab(seedCorpus) {
    const chars = new Set(['<', '|', 'j', 's', 'p', 'y', '>', 'e', 'n', 'd']);
    for (const ch of seedCorpus) chars.add(ch);

    const sorted = Array.from(chars).sort();
    for (const ch of sorted) {
      const idx = this.vocab.length;
      this.vocab.push(ch);
      this.charToIdx[ch] = idx;
      this.idxToChar[idx] = ch;
    }
    this.vocabSize = this.vocab.length;
    this._initWeights();
  }

  expandVocab(ch) {
    if (ch in this.charToIdx) return;
    const newIdx = this.vocab.length;
    this.vocab.push(ch);
    this.charToIdx[ch] = newIdx;
    this.idxToChar[newIdx] = ch;
    this.vocabSize = this.vocab.length;

    if (this.Wxh) {
      const rand = () => (Math.random() - 0.5) * 0.08;
      for (let i = 0; i < this.hiddenSize; i++) {
        const nextW = new Float64Array(this.vocabSize);
        const nextM = new Float64Array(this.vocabSize);
        nextW.set(this.Wxh[i]);
        nextM.set(this.mWxh[i]);
        nextW[newIdx] = rand();
        this.Wxh[i] = nextW;
        this.mWxh[i] = nextM;
      }
      this.Why.push(new Float64Array(this.hiddenSize).map(() => rand()));
      this.mWhy.push(new Float64Array(this.hiddenSize));

      const nextBy = new Float64Array(this.vocabSize);
      const nextMBy = new Float64Array(this.vocabSize);
      nextBy.set(this.by);
      nextMBy.set(this.mby);
      this.by = nextBy;
      this.mby = nextMBy;
    }
  }

  _initWeights() {
    const H = this.hiddenSize;
    const V = this.vocabSize;
    const rand = (scale = 0.08) => (Math.random() - 0.5) * scale;

    this.Wxh = Array.from({ length: H }, () => new Float64Array(V).map(() => rand()));
    this.Whh = Array.from({ length: H }, () => new Float64Array(H).map(() => rand()));
    this.Why = Array.from({ length: V }, () => new Float64Array(H).map(() => rand()));
    this.bh = new Float64Array(H);
    this.by = new Float64Array(V);

    this.mWxh = Array.from({ length: H }, () => new Float64Array(V));
    this.mWhh = Array.from({ length: H }, () => new Float64Array(H));
    this.mWhy = Array.from({ length: V }, () => new Float64Array(H));
    this.mbh = new Float64Array(H);
    this.mby = new Float64Array(V);
  }

  trainStep(inputs, targets, hprev) {
    const H = this.hiddenSize;
    const V = this.vocabSize;
    const seqLen = inputs.length;
    const xs = {}, hs = {}, ys = {}, ps = {};
    hs[-1] = new Float64Array(hprev);
    let loss = 0;

    for (let t = 0; t < seqLen; t++) {
      xs[t] = inputs[t];
      hs[t] = new Float64Array(H);
      for (let i = 0; i < H; i++) {
        let sum = this.Wxh[i][xs[t]] + this.bh[i];
        for (let j = 0; j < H; j++) sum += this.Whh[i][j] * hs[t - 1][j];
        hs[t][i] = Math.tanh(sum);
      }

      ys[t] = new Float64Array(V);
      let maxVal = -Infinity;
      for (let i = 0; i < V; i++) {
        let sum = this.by[i];
        for (let j = 0; j < H; j++) sum += this.Why[i][j] * hs[t][j];
        ys[t][i] = sum;
        if (sum > maxVal) maxVal = sum;
      }

      ps[t] = new Float64Array(V);
      let sumExp = 0;
      for (let i = 0; i < V; i++) {
        ps[t][i] = Math.exp(ys[t][i] - maxVal);
        sumExp += ps[t][i];
      }
      for (let i = 0; i < V; i++) ps[t][i] /= sumExp;
      loss += -Math.log(Math.max(ps[t][targets[t]], 1e-12));
    }

    const dWxh = Array.from({ length: H }, () => new Float64Array(V));
    const dWhh = Array.from({ length: H }, () => new Float64Array(H));
    const dWhy = Array.from({ length: V }, () => new Float64Array(H));
    const dbh = new Float64Array(H);
    const dby = new Float64Array(V);
    const dhnext = new Float64Array(H);

    for (let t = seqLen - 1; t >= 0; t--) {
      const dy = new Float64Array(ps[t]);
      dy[targets[t]] -= 1;

      for (let i = 0; i < V; i++) {
        dby[i] += dy[i];
        for (let j = 0; j < H; j++) dWhy[i][j] += dy[i] * hs[t][j];
      }

      const dh = new Float64Array(H);
      for (let j = 0; j < H; j++) {
        let sum = dhnext[j];
        for (let i = 0; i < V; i++) sum += this.Why[i][j] * dy[i];
        dh[j] = (1 - hs[t][j] * hs[t][j]) * sum;
      }

      for (let i = 0; i < H; i++) {
        dbh[i] += dh[i];
        dWxh[i][xs[t]] += dh[i];
        for (let j = 0; j < H; j++) dWhh[i][j] += dh[i] * hs[t - 1][j];
      }

      for (let j = 0; j < H; j++) {
        let sum = 0;
        for (let i = 0; i < H; i++) sum += this.Whh[i][j] * dh[i];
        dhnext[j] = sum;
      }
    }

    const clip = 5;
    const update = (w, dw, mw) => {
      for (let i = 0; i < w.length; i++) {
        let d = Math.max(-clip, Math.min(clip, dw[i]));
        mw[i] += d * d;
        w[i] -= (this.lr * d) / Math.sqrt(mw[i] + 1e-8);
      }
    };

    for (let i = 0; i < H; i++) {
      update(this.Wxh[i], dWxh[i], this.mWxh[i]);
      update(this.Whh[i], dWhh[i], this.mWhh[i]);
      let d = Math.max(-clip, Math.min(clip, dbh[i]));
      this.mbh[i] += d * d;
      this.bh[i] -= (this.lr * d) / Math.sqrt(this.mbh[i] + 1e-8);
    }
    for (let i = 0; i < V; i++) {
      update(this.Why[i], dWhy[i], this.mWhy[i]);
      let d = Math.max(-clip, Math.min(clip, dby[i]));
      this.mby[i] += d * d;
      this.by[i] -= (this.lr * d) / Math.sqrt(this.mby[i] + 1e-8);
    }

    this.totalSteps++;
    this.recentLoss = loss / seqLen;
    return { loss: this.recentLoss, hlast: hs[seqLen - 1] };
  }

  trainOnCode(code, lang = 'js', seqLength = 25, iterations = 6) {
    const prefix = lang === 'python' || lang === 'py' ? '<|py|>' : '<|js|>';
    const fullText = `${prefix}${code}<|end|>`;
    for (const ch of fullText) this.expandVocab(ch);

    let hprev = new Float64Array(this.hiddenSize);
    let avgLoss = 0, count = 0;

    for (let iter = 0; iter < iterations; iter++) {
      let p = 0;
      while (p + seqLength + 1 <= fullText.length) {
        const inputs = [], targets = [];
        for (let i = 0; i < seqLength; i++) {
          inputs.push(this.charToIdx[fullText[p + i]]);
          targets.push(this.charToIdx[fullText[p + i + 1]]);
        }
        const { loss, hlast } = this.trainStep(inputs, targets, hprev);
        hprev = hlast;
        avgLoss += loss;
        count++;
        p += seqLength;
      }
    }
    return count > 0 ? avgLoss / count : 0;
  }

  generate(prompt, lang = 'js', length = 80, temperature = 0.7) {
    const prefix = lang === 'python' || lang === 'py' ? '<|py|>' : '<|js|>';
    const seed = `${prefix}${prompt}`;
    for (const ch of seed) this.expandVocab(ch);

    let h = new Float64Array(this.hiddenSize);
    let lastChar = seed[seed.length - 1];

    for (const ch of seed) {
      const idx = this.charToIdx[ch] ?? 0;
      const nextH = new Float64Array(this.hiddenSize);
      for (let i = 0; i < this.hiddenSize; i++) {
        let sum = this.Wxh[i][idx] + this.bh[i];
        for (let j = 0; j < this.hiddenSize; j++) sum += this.Whh[i][j] * h[j];
        nextH[i] = Math.tanh(sum);
      }
      h = nextH;
    }

    let generated = '';
    for (let t = 0; t < length; t++) {
      const idx = this.charToIdx[lastChar] ?? 0;
      const nextH = new Float64Array(this.hiddenSize);
      for (let i = 0; i < this.hiddenSize; i++) {
        let sum = this.Wxh[i][idx] + this.bh[i];
        for (let j = 0; j < this.hiddenSize; j++) sum += this.Whh[i][j] * h[j];
        nextH[i] = Math.tanh(sum);
      }
      h = nextH;

      const y = new Float64Array(this.vocabSize);
      let maxVal = -Infinity;
      for (let i = 0; i < this.vocabSize; i++) {
        let sum = this.by[i];
        for (let j = 0; j < this.hiddenSize; j++) sum += this.Why[i][j] * h[j];
        y[i] = sum / Math.max(temperature, 0.1);
        if (y[i] > maxVal) maxVal = y[i];
      }

      let sumExp = 0;
      const p = new Float64Array(this.vocabSize);
      for (let i = 0; i < this.vocabSize; i++) {
        p[i] = Math.exp(y[i] - maxVal);
        sumExp += p[i];
      }
      for (let i = 0; i < this.vocabSize; i++) p[i] /= sumExp;

      const r = Math.random();
      let acc = 0, sampledIdx = 0;
      for (let i = 0; i < this.vocabSize; i++) {
        acc += p[i];
        if (r < acc) { sampledIdx = i; break; }
      }

      const nextChar = this.idxToChar[sampledIdx] || '';
      generated += nextChar;
      if (generated.includes('<|end|>')) break;
      lastChar = nextChar;
    }

    return prompt + generated.replace(/<\|end\|>/g, '');
  }
}

module.exports = { CoderModel };