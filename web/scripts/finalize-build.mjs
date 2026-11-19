// 构建后处理：写 app/BUILD_INFO.json，并检查产物中没有禁用引用。
// sourceHash 的规范算法与 tools/shell_build_check.py 完全一致（设计 7.4）：
//   取 web/index.html、package.json、package-lock.json、tsconfig*.json、vite.config.ts、vitest.config.ts、
//   public/**、scripts/**、src/**，按 POSIX 相对路径升序，sha256( Σ relpath + "\0" + sha256(file) + "\n" )。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(WEB, '..', 'app');
const INFO_NAME = 'BUILD_INFO.json';

const TOP_FILES = ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'vitest.config.ts'];
const TREE_DIRS = ['public', 'scripts', 'src'];
// 与 shell_build_check.py 使用同一组模式：引用旧版资源路径、以及被禁用的库。
const FORBIDDEN_REF = /["'(=\s]\/(?:js\/|assets\/css\/)/;
const FORBIDDEN_LIB = /\b(?:lenis|gsap)\b/i;
const MAX_ENTRY_GZIP = 500 * 1024;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const posix = (path) => path.split(sep).join('/');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function sourceFiles() {
  const found = [];
  for (const name of readdirSync(WEB)) {
    if (TOP_FILES.includes(name) || /^tsconfig.*\.json$/.test(name)) found.push(join(WEB, name));
  }
  for (const dir of TREE_DIRS) {
    if (existsSync(join(WEB, dir))) found.push(...walk(join(WEB, dir)));
  }
  return found
    .filter((path) => statSync(path).isFile())
    .map((path) => posix(relative(WEB, path)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function computeSourceHash() {
  const hash = createHash('sha256');
  for (const rel of sourceFiles()) {
    hash.update(Buffer.from(rel + '\0' + sha256(readFileSync(join(WEB, rel))) + '\n', 'utf8'));
  }
  return hash.digest('hex');
}

function readVersion(name) {
  return JSON.parse(readFileSync(join(WEB, 'node_modules', name, 'package.json'), 'utf8')).version;
}

function main() {
  if (!existsSync(join(APP, 'index.html'))) throw new Error('app/index.html 不存在：请先运行 vite build');
  const files = walk(APP)
    .map((path) => posix(relative(APP, path)))
    .filter((rel) => rel !== INFO_NAME)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((rel) => {
      const data = readFileSync(join(APP, rel));
      return { path: rel, sha256: sha256(data), bytes: data.length };
    });

  const problems = [];
  for (const { path } of files) {
    if (!/\.(?:html|js|css|json|svg|txt|webmanifest|mjs)$/.test(path)) continue;
    const text = readFileSync(join(APP, path), 'utf8');
    if (FORBIDDEN_REF.test(text)) problems.push(`${path}: 引用了旧版资源路径 /js/ 或 /assets/css/`);
    if (FORBIDDEN_LIB.test(text)) problems.push(`${path}: 包含被禁用的库 lenis/gsap`);
  }

  const html = readFileSync(join(APP, 'index.html'), 'utf8');
  const match = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html) ?? /<script[^>]*src="([^"]+)"[^>]*type="module"/.exec(html);
  if (!match) throw new Error('index.html 中找不到入口 module script');
  const entryFile = match[1].replace(/^\/app\//, '');
  const entryData = readFileSync(join(APP, entryFile));
  const gzipBytes = gzipSync(entryData, { level: 9 }).length;
  if (gzipBytes > MAX_ENTRY_GZIP) problems.push(`入口 chunk gzip ${gzipBytes} 字节超过 ${MAX_ENTRY_GZIP}`);

  if (problems.length) {
    for (const problem of problems) console.error('构建检查失败: ' + problem);
    process.exit(1);
  }

  const info = {
    sourceHash: computeSourceHash(),
    builtAt: new Date().toISOString(),
    node: process.version,
    versions: { vite: readVersion('vite'), react: readVersion('react'), typescript: readVersion('typescript') },
    files,
    entry: { file: entryFile, gzipBytes },
  };
  writeFileSync(join(APP, INFO_NAME), JSON.stringify(info, null, 2) + '\n', 'utf8');
  console.log(`BUILD_INFO.json 已写入：${files.length} 个文件，入口 ${entryFile} gzip ${gzipBytes} 字节`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
