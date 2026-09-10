const vm = require('vm');
const { spawnSync } = require('child_process');

class SyntaxValidator {
  static validateJS(code) {
    if (!code || typeof code !== 'string') return false;
    try {
      new vm.Script(code);
      return true;
    } catch {
      return false;
    }
  }

  static validatePython(code) {
    if (!code || typeof code !== 'string') return false;
    try {
      const proc = spawnSync('python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], {
        input: code,
        encoding: 'utf-8',
        timeout: 2000
      });
      return proc.status === 0;
    } catch {
      return true;
    }
  }

  static validate(code, lang) {
    if (lang === 'javascript' || lang === 'js') return this.validateJS(code);
    if (lang === 'python' || lang === 'py') return this.validatePython(code);
    return false;
  }
}

module.exports = { SyntaxValidator };
