// 本地打包脚本：复刻官方 @songloft/plugin-builder 的构建产物与 hash 算法，
// 绕开 Windows/Git-Bash 下官方 CLI 的 execFileSync 退出码问题。
// 产物与官方完全一致：main.jsc + static/ + plugin.json(带 hash) + zip

import { build } from 'esbuild';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  readFileSync, writeFileSync, mkdirSync, rmSync,
  readdirSync, statSync, renameSync, existsSync, unlinkSync, copyFileSync,
} from 'fs';
import { join, relative, dirname, basename, posix } from 'path';
import JSZip from 'jszip';

const cwd = process.cwd();
const outDir = join(cwd, 'dist');
const buildDir = join(outDir, '_build');
const sha256 = (d) => createHash('sha256').update(d).digest('hex');

// 手动递归复制（cpSync 在中文路径 + Git Bash 下会静默失败）
function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const item of readdirSync(src)) {
    const s = join(src, item), d = join(dst, item);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

// 1. 清理并建目录
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

// 2. esbuild 编译后端
const entry = join(cwd, 'src', 'main.ts');
await build({
  entryPoints: [entry],
  outfile: join(buildDir, 'main.js'),
  bundle: true,
  platform: 'neutral',
  format: 'iife',
  target: 'es2020',
  minify: true,
});
console.log('[1/5] esbuild OK');

// 3. jsc 编译 main.js -> main.jsc
const jscPath = join(cwd, 'node_modules', '@songloft', 'jsc-win32-x64', 'bin', 'jsc.exe');
let mainFileName = 'main.js';
try {
  execFileSync(jscPath, [join(buildDir, 'main.js'), join(buildDir, 'main.jsc')], { stdio: 'pipe' });
  unlinkSync(join(buildDir, 'main.js'));
  mainFileName = 'main.jsc';
  console.log('[2/5] jsc OK -> main.jsc');
} catch (e) {
  console.log('[2/5] jsc failed, keeping main.js:', String(e.stderr || e.message).slice(0, 200));
}

// 4. 复制 static / bin
if (existsSync(join(cwd, 'static'))) copyDir(join(cwd, 'static'), join(buildDir, 'static'));
if (existsSync(join(cwd, 'bin'))) copyDir(join(cwd, 'bin'), join(buildDir, 'bin'));

// 4b. 打包 static/js/app.js -> app.bundle.js（官方行为）
const appJs = join(buildDir, 'static', 'js', 'app.js');
if (existsSync(appJs)) {
  await build({
    entryPoints: [appJs],
    outfile: join(buildDir, 'static', 'js', 'app.bundle.js'),
    bundle: true, platform: 'browser', format: 'iife', target: 'es2020', minify: true,
  });
  // 改 index.html 的 script 引用；带内容 hash 防止浏览器永久缓存旧 bundle
  const idxPath = join(buildDir, 'static', 'index.html');
  if (existsSync(idxPath)) {
    let html = readFileSync(idxPath, 'utf-8');
    const bundleHash = sha256(readFileSync(join(buildDir, 'static', 'js', 'app.bundle.js'))).slice(0, 8);
    const before = html;
    html = html.replace(
      /<script\b[^>]*\bsrc="(?:static\/)?js\/app\.js"[^>]*><\/script>/,
      '<script src="static/js/app.bundle.js?v=' + bundleHash + '"></script>'
    );
    if (html === before) throw new Error('index.html 缺少 app.js 的 script 标签');
    writeFileSync(idxPath, html);
  }
  // 删除其它 js，只留 bundle
  const jsDir = join(buildDir, 'static', 'js');
  for (const f of readdirSync(jsDir)) {
    if (f.endsWith('.js') && f !== 'app.bundle.js') unlinkSync(join(jsDir, f));
  }
  console.log('[3/5] static/js bundled');
}

// 4c. 静态资源加 hash（简化版：只处理 icon/css，重写 index.html 引用）
function walk(dir) {
  const out = [];
  for (const item of readdirSync(dir)) {
    const p = join(dir, item);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const staticDir = join(buildDir, 'static');
if (existsSync(staticDir)) {
  const renameMap = new Map();
  const ASSET = /\.(woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|ico|mp3|mp4|wav|ogg)$/i;
  const CSS = /\.css$/i;
  for (const f of walk(staticDir)) {
    const rel = posix.normalize(relative(staticDir, f).replace(/\\/g, '/'));
    if (!ASSET.test(f) && !CSS.test(f)) continue;
    const hash = sha256(readFileSync(f)).slice(0, 8);
    const dot = basename(rel).lastIndexOf('.');
    const name = basename(rel);
    const newBase = dot <= 0 ? `${name}.${hash}` : `${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
    const dir = dirname(rel);
    const newRel = dir === '.' ? newBase : posix.join(dir, newBase);
    renameSync(f, join(staticDir, newRel));
    renameMap.set(rel, newRel);
  }
  // 重写 index.html 引用
  const idxPath = join(staticDir, 'index.html');
  if (existsSync(idxPath)) {
    let html = readFileSync(idxPath, 'utf-8');
    for (const [oldR, newR] of renameMap.entries()) {
      const oldBase = basename(oldR), newBase = basename(newR);
      html = html.split(oldBase).join(newBase);
    }
    writeFileSync(idxPath, html);
  }
  // 更新 plugin.json 的 icon
  console.log('[4/5] static hashed', renameMap.size, 'files');
}

// 5. 计算 hash，写 plugin.json
const mainContent = readFileSync(join(buildDir, mainFileName));
const entryHash = sha256(mainContent);

function canonicalZipHash(dir) {
  const entries = [];
  function w(d) {
    for (const item of readdirSync(d)) {
      const p = join(d, item);
      if (statSync(p).isDirectory()) w(p);
      else {
        const rel = posix.normalize(relative(dir, p).replace(/\\/g, '/'));
        if (rel === 'plugin.json') continue;
        entries.push({ path: rel, hash: sha256(readFileSync(p)) });
      }
    }
  }
  w(dir);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const h = createHash('sha256');
  for (const e of entries) h.update(e.path + '\n' + e.hash + '\n');
  return h.digest('hex');
}

const manifest = JSON.parse(readFileSync(join(cwd, 'plugin.json'), 'utf-8'));
// 更新 icon 名（若被 hash）
if (manifest.icon) {
  const iconBase = basename(manifest.icon);
  const stem = iconBase.slice(0, iconBase.lastIndexOf('.')) || iconBase;
  for (const f of walk(staticDir)) {
    const b = basename(f);
    if (b === iconBase) break; // 未被 hash
    if (b.startsWith(stem + '.') && /\.[0-9a-f]{8}\./i.test(b)) {
      const rel = posix.normalize(relative(staticDir, f).replace(/\\/g, '/'));
      manifest.icon = rel;
      break;
    }
  }
}
const finalManifest = { ...manifest, main: mainFileName, entryHash, zipHash: '' };
writeFileSync(join(buildDir, 'plugin.json'), JSON.stringify(finalManifest, null, 2));
const zipHash = canonicalZipHash(buildDir);
finalManifest.zipHash = zipHash;
writeFileSync(join(buildDir, 'plugin.json'), JSON.stringify(finalManifest, null, 2));

// 6. 生成 zip
const zip = new JSZip();
function addDir(zipObj, dir, prefix) {
  for (const item of readdirSync(dir)) {
    const p = join(dir, item);
    const zp = prefix ? `${prefix}/${item}` : item;
    if (statSync(p).isDirectory()) addDir(zipObj, p, zp);
    else zipObj.file(zp, readFileSync(p));
  }
}
addDir(zip, buildDir, '');
const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
mkdirSync(outDir, { recursive: true });
const zipPath = join(outDir, `${manifest.entryPath}.jsplugin.zip`);
writeFileSync(zipPath, buf);

console.log('[5/5] BUILD OK');
console.log('  zip:', zipPath, (buf.length / 1024).toFixed(1), 'KB');
console.log('  entryHash:', entryHash);
console.log('  zipHash:', zipHash);
