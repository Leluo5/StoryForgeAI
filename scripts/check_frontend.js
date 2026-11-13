#!/usr/bin/env node
/**
 * 前端代码规范违规检查脚本
 * 对应规范：《开发规范》02-前端规范与API约定.md
 * 检查项：内联onclick、内联style、innerHTML注入(未消毒)、裸fetch(未走api.request)、
 *         sessionStorage明文存token、表单控件缺aria-label、<button>缺type、
 *         DOM选择器重复/全局事件绑定、文件上传innerHTML拼接用户数据、console.log残留。
 *
 * 用法:
 *     node scripts/check_frontend.js [--path 根目录] [--quiet]
 * 退出码: 0=无违规, 1=存在违规
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(path.dirname(__filename));
const STATIC_DIR = path.join(ROOT, "static");
const TEMPLATE_DIR = path.join(ROOT, "templates");

let violations = [];

function Violation(file, line, rule, message, severity = "MUST") {
  return { file, line, rule, message, severity };
}

function collectFiles(dir, exts) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", ".git"].includes(entry.name)) results.push(...collectFiles(full, exts));
    } else if (exts.some((e) => full.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

// 封装函数体行范围：api.request / api.requestRaw / 组件 _request 内部的 fetch 属合法实现，不计入裸 fetch
function fetchWrapperBodyRanges(lines) {
  const ranges = [];
  const defRe = /async\s+(request|requestRaw)\s*\(|async\s+function\s+_request\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    if (!defRe.test(lines[i])) continue;
    // 定位函数体起始的花括号：跳过参数列表（含默认值 {}），括号平衡后找第一个 { 
    const m = lines[i].match(/\(/);
    if (!m) continue;
    let depth = 0, bodyStart = -1, seenOpen = false;
    for (let j = m.index; j < lines[i].length; j++) {
      const ch = lines[i][j];
      if (ch === "(") { depth++; seenOpen = true; }
      else if (ch === ")") {
        depth--;
        if (depth === 0 && seenOpen) {
          // 参数列表结束，跳过默认值 {}，找真正的函数体 '{'
          const rest = lines[i].slice(j + 1);
          const k = rest.indexOf("{");
          if (k >= 0) { bodyStart = j + 1 + k; }
          break;
        }
      }
    }
    if (bodyStart < 0) {
      // 签名跨行，退化为直接找 { 
      bodyStart = lines[i].indexOf("{");
    }
    if (bodyStart < 0) continue;
    let d = 0, started = false, end = -1;
    for (let j = i; j < lines.length && end < 0; j++) {
      const seg = (j === i) ? lines[j].slice(bodyStart) : lines[j];
      for (const ch of seg) {
        if (ch === "{") { d++; started = true; }
        else if (ch === "}") {
          d--;
          if (started && d === 0) { end = j; break; }
        }
      }
    }
    if (end >= 0) ranges.push([i, end]);
  }
  return ranges;
}

function checkJS(file) {
  const src = fs.readFileSync(file, "utf-8");
  const lines = src.split("\n");
  const wrapperRanges = fetchWrapperBodyRanges(lines);
  const inWrapper = (n) => wrapperRanges.some(([s, e]) => n >= s + 1 && n <= e + 1);
  lines.forEach((line, idx) => {
    const n = idx + 1;
    // 内联事件：el.onclick = / addEventListener 无清理（全局document绑定）
    if (/\.onclick\s*=\s*function|\.onclick\s*=\s*\(/.test(line)) {
      violations.push(Violation(file, n, "3.4-内联事件", "内联 .onclick 赋值，应统一 addEventListener"));
    }
    // innerHTML 注入（未消毒：非 sanitizeHtml/escapeHtml 包裹）
    if (/\.innerHTML\s*=/.test(line) && !/sanitizeHtml|escapeHtml|renderMarkdown/.test(line)) {
      violations.push(Violation(file, n, "3.4-DOM安全", "innerHTML 直接赋值且未走 sanitizeHtml/escapeHtml 消毒"));
    }
    // 裸 fetch（未走 api.request / api.）。跳过封装函数体（api.request/requestRaw/_request）内的合法实现。
    if (/\bfetch\(/.test(line) && !/api\.(request|post|get|upload)/.test(line) && !inWrapper(n)) {
      violations.push(Violation(file, n, "3.3-API封装", "裸 fetch 未走统一 api.request 封装"));
    }
    // sessionStorage 存 token
    if (/sessionStorage\.setItem\(\s*['"]adminToken/.test(line)) {
      violations.push(Violation(file, n, "安全-token", "sessionStorage 明文持久化 adminToken，应改内存变量"));
    }
    // console.log 残留
    if (/console\.log\(/.test(line)) {
      violations.push(Violation(file, n, "3.4-调试残留", "console.log 调试残留", "SHOULD"));
    }
  });
  // 事件泄漏检测（SPA 单次初始化 + 事件委托属正当模式，不误报）：
  // 1) 同一固定目标（仅 getElementById，id 全局唯一）+ 同一事件类型重复绑定
  //    （querySelector 可匹配动态渲染的多实例，不作重复依据）
  // 2) 非委托式全局 document/window 绑定过多且无 removeEventListener（无清理）
  const idEvRe = /getElementById\('([^']+)'\)\.addEventListener\(\s*(['"])([\w]+)\2/g;
  const bindCounts = new Map(); // "id::eventType" -> 次数
  let m;
  while ((m = idEvRe.exec(src)) !== null) {
    const key = m[1] + "::" + m[3];
    bindCounts.set(key, (bindCounts.get(key) || 0) + 1);
  }
  let dupFound = false;
  bindCounts.forEach((cnt, key) => {
    if (cnt > 1) { dupFound = true; violations.push(Violation(file, 1, "3.4-事件清理", `目标 "${key}" 被重复绑定 ${cnt} 次，存在重复/泄漏风险`, "SHOULD")); }
  });
  // 非委托式全局绑定：直接绑到 document/window 且处理函数不依赖 e.target 委托
  const addCount = (src.match(/document\.addEventListener|window\.addEventListener/g) || []).length;
  const removeCount = (src.match(/removeEventListener/g) || []).length;
  const delegated = /document\.addEventListener\(\s*['"](click|change|keydown|input)['"]/.test(src) &&
                    /function\s*\(e\)|\(e\)\s*=>/.test(src);
  if (!dupFound && !delegated && addCount > 5 && removeCount < 2) {
    violations.push(Violation(file, 1, "3.4-事件清理", `全局事件绑定 ${addCount} 处但 removeEventListener 仅 ${removeCount} 处，需清理或委托`, "SHOULD"));
  }
}

function checkCSS(file) {
  const src = fs.readFileSync(file, "utf-8");
  const lines = src.split("\n");
  // 注释块区间（/* ... */，支持跨行），用于跳过注释内的 !important 字样
  const commentRanges = [];
  let inComment = false, cStart = -1;
  lines.forEach((line, i) => {
    let j = 0;
    while (j < line.length) {
      if (!inComment) {
        const k = line.indexOf("/*", j);
        if (k < 0) break;
        inComment = true; cStart = i + 1; j = k + 2;
      } else {
        const k = line.indexOf("*/", j);
        if (k < 0) { j = line.length; }
        else { inComment = false; commentRanges.push([cStart, i + 1]); j = k + 2; }
      }
    }
  });
  if (inComment) commentRanges.push([cStart, lines.length]);
  const inCommentAt = (n) => commentRanges.some(([s, e]) => n >= s && n <= e);
  // 跟踪 @media (prefers-reduced-motion: reduce) 块：该块内 !important 是无障碍标准写法，豁免
  let inReducedMotion = false;
  lines.forEach((line, idx) => {
    const n = idx + 1;
    // 硬编码颜色字面量（非 :root 变量）：如 #fff / rgb( 但非 var()
    if (/#[0-9a-fA-F]{3,8}\b/.test(line) && !/var\(/.test(line) && !/:root|--/.test(line)) {
      violations.push(Violation(file, n, "3.2-颜色变量", "硬编码颜色字面量，应收敛为 :root CSS 变量", "SHOULD"));
    }
    // z-index 超分级（>2000）
    const zi = line.match(/z-index\s*:\s*(\d+)/);
    if (zi && parseInt(zi[1], 10) > 2000) {
      violations.push(Violation(file, n, "3.2-z-index", `z-index=${zi[1]} 超分级，应归入 1000 档`));
    }
    // @media (prefers-reduced-motion: reduce) 块进入/退出跟踪
    if (/@media\s*\(prefers-reduced-motion:\s*reduce\)/i.test(line)) {
      inReducedMotion = true;
    }
    if (/^\s*}\s*$/.test(line) && inReducedMotion) {
      // 简单估算：reduced-motion 块内的 } 视为块结束（该块内无嵌套 @media）
      inReducedMotion = false;
    }
    // !important 滥用（跳过注释块内的字样；reduced-motion 无障碍块豁免）
    if (/!important/.test(line) && !inCommentAt(n) && !inReducedMotion) {
      violations.push(Violation(file, n, "3.2-样式", "!important 滥用，应改用选择器优先级", "SHOULD"));
    }
  });
}

function checkHTML(file) {
  const src = fs.readFileSync(file, "utf-8");
  const lines = src.split("\n");
  lines.forEach((line, idx) => {
    const n = idx + 1;
    // 内联 onclick
    if (/\bonclick=/.test(line)) {
      violations.push(Violation(file, n, "3.4-内联事件", "内联 onclick= 属性，应统一 addEventListener"));
    }
    // 内联 style
    if (/\bstyle="[^"]*"/.test(line) && !/display:\s*none/.test(line)) {
      violations.push(Violation(file, n, "3.2-内联style", "内联 style 属性，应提炼为 class", "SHOULD"));
    }
    // <button> 缺 type
    if (/<button\b[^>]*>/i.test(line) && !/\btype=/.test(line)) {
      violations.push(Violation(file, n, "3.4-按钮type", "<button> 缺 type=\"button\"，默认提交"));
    }
    // 表单控件缺 aria-label（input/select/textarea 无 aria-label 无 label 关联）
    if (/<(input|select|textarea)\b[^>]*>/i.test(line) && !/aria-label|id=/.test(line)) {
      violations.push(Violation(file, n, "3.4-无障碍", "表单控件缺 aria-label 或 id 关联", "SHOULD"));
    }
  });
}

function main() {
  const args = process.argv.slice(2);
  const quiet = args.includes("--quiet");
  const pathIdx = args.indexOf("--path");
  const root = pathIdx >= 0 ? path.resolve(args[pathIdx + 1]) : ROOT;

  for (const f of collectFiles(path.join(root, "static", "js"), [".js"])) checkJS(f);
  for (const f of collectFiles(path.join(root, "static", "css"), [".css"])) checkCSS(f);
  for (const f of collectFiles(path.join(root, "templates"), [".html"])) checkHTML(f);

  if (!quiet) {
    violations.forEach((v) => {
      const rel = path.relative(root, v.file);
      console.log(`${v.severity} | ${rel}:${v.line} | ${v.rule} | ${v.message}`);
    });
  }
  const must = violations.filter((v) => v.severity === "MUST").length;
  const should = violations.filter((v) => v.severity === "SHOULD").length;
  console.log(`\n[check_frontend] 共 ${violations.length} 条违规（MUST ${must} / SHOULD ${should}）`);
  return violations.length > 0 ? 1 : 0;
}

process.exit(main());
