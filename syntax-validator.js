const { spawnSync } = require('child_process');
let acorn = null;
try {
  acorn = require('acorn');
} catch (e) {}

class SyntaxValidator {
  static validateJS(code) {
    if (!code || typeof code !== 'string') return false;

    // 1. Проверка через встроенный парсер acorn с поддержкой ES Modules и Modern JS
    if (acorn) {
      try {
        acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
        return true;
      } catch {
        try {
          acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
          return true;
        } catch {
          return false;
        }
      }
    }

    // 2. Fallback через встроенный модуль vm
    try {
      const vm = require('vm');
      new vm.Script(code);
      return true;
    } catch (err) {
      // Игнорируем ограничения среды на import/export в модулях
      if (
        err.message.includes('Cannot use import statement') ||
        err.message.includes("Unexpected token 'export'")
      ) {
        return true;
      }
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