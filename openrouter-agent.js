#!/usr/bin/env node
// OpenRouter Agent — local server with terminal access
// Run:  node openrouter-agent.js
// Open: http://localhost:3001
'use strict';
const http = require('http'), https = require('https');
const { exec } = require('child_process');
const fs = require('fs'), path = require('path'), url = require('url'), os = require('os');

const PORT = 3001;
const OLLAMA = 'http://localhost:11434';
let cwd = process.env.HOME || process.cwd();

// ── Config: rules + skills stored as editable files ───────────────
const CONFIG_DIR = path.join(os.homedir(), '.openrouter-agent');
const RULES_DIR  = path.join(CONFIG_DIR, 'rules');
const SKILLS_DIR = path.join(CONFIG_DIR, 'skills');

function ensureConfig() {
  fs.mkdirSync(RULES_DIR, { recursive: true });
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const seed = (dir, name, content) => {
    const fp = path.join(dir, name);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, content, 'utf8');
  };
  seed(RULES_DIR, 'default.md',
`# Working rules
- Be concise and direct. No preamble.
- When running shell commands, prefer safe, read-only commands unless the task requires changes.
- Show your work: report what commands you ran and what they returned.
- Never destructive actions (rm -rf, disk formatting) without explicit confirmation in the message.`);
  seed(SKILLS_DIR, 'commit.md',
`---
description: Stage all changes and write a conventional-commit message
---
Run 'git status' and 'git diff --staged' (stage first with 'git add -A' if nothing is staged).
Then create a git commit with a conventional-commit message (feat/fix/refactor/docs/chore) that summarizes the changes. Show the final commit hash.`);
  seed(SKILLS_DIR, 'explain.md',
`---
description: Explain what a file or directory does
---
Read the file(s) the user names, then explain their purpose, key functions, and how they fit together. Be concrete and cite line numbers.`);
  seed(SKILLS_DIR, 'review.md',
`---
description: Review recent code changes for bugs and quality
---
Run 'git diff' (or read the files named) and review for correctness bugs, security issues, and quality problems. List findings by severity (CRITICAL/HIGH/MEDIUM/LOW) with file:line and a concrete fix.`);
}
ensureConfig();

function readRules() {
  try {
    return fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.md')).sort()
      .map(f => ({ name: f.replace(/\.md$/, ''), content: fs.readFileSync(path.join(RULES_DIR, f), 'utf8') }));
  } catch { return []; }
}
function readSkills() {
  try {
    return fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md')).sort().map(f => {
      const raw = fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8');
      const name = f.replace(/\.md$/, '');
      let desc = '', body = raw;
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
      if (m) { body = m[2]; const dm = m[1].match(/description:\s*(.+)/i); if (dm) desc = dm[1].trim(); }
      else { desc = (raw.split('\n').find(l => l.trim()) || '').replace(/^#+\s*/, '').slice(0, 90); }
      return { name, description: desc, body: body.trim() };
    });
  } catch { return []; }
}
const safeName = n => String(n || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 60);

// ── Route handlers ────────────────────────────────────────────────
async function handle(req, res) {
  const p = url.parse(req.url).pathname;
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && p === '/') {
    res.writeHead(200, {'Content-Type':'text/html;charset=utf-8'});
    return res.end(HTML);
  }
  if (req.method === 'GET' && p === '/cwd') {
    return json(res, { cwd });
  }
  // Rules + skills
  if (req.method === 'GET' && p === '/config') {
    return json(res, { rules: readRules(), skills: readSkills() });
  }
  // List locally-installed Ollama models
  if (req.method === 'GET' && p === '/local/models') {
    return proxyGet(OLLAMA + '/api/tags', (err, data) => {
      if (err) return json(res, { models: [], error: err });
      try {
        const models = JSON.parse(data).models.map(m => m.name);
        json(res, { models });
      } catch { json(res, { models: [] }); }
    });
  }

  if (req.method === 'POST') {
    let body = ''; for await (const c of req) body += c;
    let d; try { d = JSON.parse(body); } catch { res.writeHead(400); return res.end('bad json'); }

    // Proxy chat to local Ollama (OpenAI-compatible endpoint). Streams straight through.
    if (p === '/local/chat') {
      const payload = JSON.stringify(d);
      const upstream = http.request(OLLAMA + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, up => {
        res.writeHead(up.statusCode, { 'Content-Type': up.headers['content-type'] || 'text/event-stream' });
        up.pipe(res);
      });
      upstream.on('error', e => { json(res, { error: { message: 'Ollama not reachable: ' + e.message } }); });
      upstream.write(payload); upstream.end();
      return;
    }

    if (p === '/run') {
      const cmd = String(d.command || '').trim();
      if (!cmd) return json(res, { error: 'empty command' });
      const cdMatch = cmd.match(/^cd\s+(.*)/);
      if (cdMatch) {
        const t = cdMatch[1].trim().replace(/^~(?=$|\/)/, process.env.HOME || '');
        const resolved = path.resolve(cwd, t);
        try { fs.accessSync(resolved); cwd = resolved; return json(res, { stdout:'', stderr:'', cwd }); }
        catch { return json(res, { stdout:'', stderr:`cd: ${t}: No such file or directory`, cwd }); }
      }
      exec(cmd, { cwd, timeout: 30000, maxBuffer: 2*1024*1024 }, (err, out, errOut) => {
        json(res, { stdout: out||'', stderr: errOut||(err&&!errOut?err.message:'')||'', exitCode: err?.code??0, cwd });
      });
      return;
    }

    if (p === '/fs/read') {
      const fp = path.resolve(cwd, String(d.path||''));
      try { const c = fs.readFileSync(fp,'utf8'); json(res,{content:c}); }
      catch(e) { json(res,{error:e.message}); }
      return;
    }
    if (p === '/fs/write') {
      const fp = path.resolve(cwd, String(d.path||''));
      try { fs.mkdirSync(path.dirname(fp),{recursive:true}); fs.writeFileSync(fp,String(d.content||''),'utf8'); json(res,{ok:true,path:fp}); }
      catch(e) { json(res,{error:e.message}); }
      return;
    }
    if (p === '/config/save') {
      const kind = d.kind === 'rule' ? RULES_DIR : d.kind === 'skill' ? SKILLS_DIR : null;
      const nm = safeName(d.name);
      if (!kind || !nm) return json(res, { error: 'invalid kind or name' });
      try { fs.writeFileSync(path.join(kind, nm + '.md'), String(d.content || ''), 'utf8'); json(res, { ok: true }); }
      catch (e) { json(res, { error: e.message }); }
      return;
    }
    if (p === '/config/delete') {
      const kind = d.kind === 'rule' ? RULES_DIR : d.kind === 'skill' ? SKILLS_DIR : null;
      const nm = safeName(d.name);
      if (!kind || !nm) return json(res, { error: 'invalid' });
      try { fs.unlinkSync(path.join(kind, nm + '.md')); json(res, { ok: true }); }
      catch (e) { json(res, { error: e.message }); }
      return;
    }
    if (p === '/fs/list') {
      const dp = path.resolve(cwd, String(d.path||'.'));
      try {
        const entries = fs.readdirSync(dp,{withFileTypes:true})
          .map(e => ({name:e.name, type:e.isDirectory()?'dir':'file'}))
          .sort((a,b) => a.type===b.type ? a.name.localeCompare(b.name) : a.type==='dir'?-1:1);
        json(res,{path:dp,entries});
      } catch(e) { json(res,{error:e.message}); }
      return;
    }
  }
  res.writeHead(404); res.end('not found');
}

function json(res, d) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(d)); }
function proxyGet(u, cb) {
  http.get(u, r => { let s=''; r.on('data',c=>s+=c); r.on('end',()=>cb(null,s)); })
      .on('error', e => cb(e.message));
}

const server = http.createServer(handle);
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n  ⚠  Port ${PORT} is already in use.`);
    console.log(`     An instance is probably already running — just open http://localhost:${PORT}`);
    console.log(`     To restart fresh, kill it first:  lsof -ti:${PORT} | xargs kill\n`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT,'127.0.0.1', () => {
  console.log(`\n  OpenRouter Agent  →  http://localhost:${PORT}\n`);
  console.log(`  Chat mode: streaming conversation`);
  console.log(`  Agent mode: full terminal + file access\n`);
});

// ── Embedded UI ───────────────────────────────────────────────────
const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent · OpenRouter</title>
<style>
:root{--bg:#0C0E14;--sf:#111520;--sf2:#171B27;--bd:#1D2235;--bd2:#252D44;--tx:#DDE0EE;--tx2:#7A82A0;--tx3:#434D68;--ac:#4B78F5;--ac2:#3360D9;--ac-bg:rgba(75,120,245,.08);--u-bg:#152040;--u-bd:#1E3066;--code:#080A10;--r:7px;--rl:11px}
@media(prefers-color-scheme:light){:root{--bg:#F3F5FB;--sf:#fff;--sf2:#EEF1FA;--bd:#DEE2F0;--bd2:#C5CCDF;--tx:#0B0D18;--tx2:#4E5670;--tx3:#8C94B0;--ac:#2952D9;--ac2:#1E42B8;--ac-bg:rgba(41,82,217,.06);--u-bg:#EAF0FF;--u-bd:#B8C8F0;--code:#EEF1FA}}
:root[data-theme=dark]{--bg:#0C0E14;--sf:#111520;--sf2:#171B27;--bd:#1D2235;--bd2:#252D44;--tx:#DDE0EE;--tx2:#7A82A0;--tx3:#434D68;--ac:#4B78F5;--ac2:#3360D9;--ac-bg:rgba(75,120,245,.08);--u-bg:#152040;--u-bd:#1E3066;--code:#080A10}
:root[data-theme=light]{--bg:#F3F5FB;--sf:#fff;--sf2:#EEF1FA;--bd:#DEE2F0;--bd2:#C5CCDF;--tx:#0B0D18;--tx2:#4E5670;--tx3:#8C94B0;--ac:#2952D9;--ac2:#1E42B8;--ac-bg:rgba(41,82,217,.06);--u-bg:#EAF0FF;--u-bd:#B8C8F0;--code:#EEF1FA}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--tx)}
body{display:flex;flex-direction:column;height:100dvh;overflow:hidden}
.hdr{display:flex;align-items:center;gap:10px;padding:0 14px;height:52px;background:var(--sf);border-bottom:1px solid var(--bd);flex-shrink:0}
.logo{font-size:13.5px;font-weight:700;letter-spacing:-.4px;flex-shrink:0}.logo em{color:var(--ac);font-style:normal}
.mdl-wrap{flex:1;display:flex;justify-content:center;min-width:0;gap:8px;align-items:center}
.mdl-sel{background:var(--sf2);border:1px solid var(--bd);color:var(--tx);padding:5px 26px 5px 9px;border-radius:var(--r);font-size:13px;font-family:inherit;outline:none;cursor:pointer;max-width:220px;width:100%;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%237A82A0' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 7px center}
.mdl-sel:focus{border-color:var(--ac)}
.cwd-chip{font-size:11px;font-family:ui-monospace,'SF Mono',monospace;background:var(--sf2);border:1px solid var(--bd);color:var(--tx2);padding:3px 9px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}
.hdr-btns{display:flex;gap:6px;flex-shrink:0;align-items:center}
.ibtn{width:30px;height:30px;border-radius:var(--r);border:1px solid var(--bd);background:var(--sf2);color:var(--tx2);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:color .14s,border-color .14s,background .14s}
.ibtn:hover{color:var(--tx);border-color:var(--bd2)}
.ibtn:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
.mode-tog{display:flex;background:var(--sf2);border:1px solid var(--bd);border-radius:var(--r);padding:2px;gap:2px}
.mode-opt{border:none;background:none;color:var(--tx3);font-family:inherit;font-size:12px;font-weight:600;padding:4px 11px;border-radius:5px;cursor:pointer;transition:color .14s,background .14s}
.mode-opt:hover{color:var(--tx2)}
.mode-opt.on{background:var(--ac);color:#fff}
.mode-opt:focus-visible{outline:2px solid var(--ac);outline-offset:1px}
.chat{flex:1;overflow-y:auto}
.chat::-webkit-scrollbar{width:4px}.chat::-webkit-scrollbar-thumb{background:var(--bd2);border-radius:4px}.chat::-webkit-scrollbar-track{background:transparent}
.msgs{max-width:760px;margin:0 auto;padding:0 20px}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:calc(100dvh - 160px);color:var(--tx3);text-align:center;padding:40px 20px}
.empty svg{opacity:.3;margin-bottom:4px}
.empty h2{font-size:16px;font-weight:500;color:var(--tx2)}
.empty p{font-size:13px;line-height:1.55;max-width:320px}
.empty code{font-family:ui-monospace,monospace;font-size:12px;background:var(--sf2);border:1px solid var(--bd);padding:1px 6px;border-radius:4px;color:var(--ac)}
.msg{display:flex;flex-direction:column;gap:6px;padding:18px 0;border-bottom:1px solid var(--bd)}
.msg:first-child{border-top:1px solid var(--bd);margin-top:20px}
.msgs>:last-child{border-bottom:none;margin-bottom:20px}
.msg.user{align-items:flex-end}.msg.asst{align-items:flex-start}
.msg-lbl{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--tx3)}
.msg.user .msg-lbl{color:var(--ac);opacity:.7}
.msg-body{font-size:14px;line-height:1.68;color:var(--tx)}
.msg.user .msg-body{background:var(--u-bg);border:1px solid var(--u-bd);border-radius:var(--rl);padding:9px 15px;max-width:72%;white-space:pre-wrap;word-break:break-word}
.msg.asst .msg-body{width:100%;padding-left:14px;border-left:2px solid var(--bd2);transition:border-color .4s}
.msg.asst.live .msg-body{border-left-color:var(--ac)}
.msg-body p{margin:0 0 10px}.msg-body p:last-child{margin-bottom:0}
.msg-body h1{font-size:17px;font-weight:600;margin:14px 0 7px}.msg-body h2{font-size:15px;font-weight:600;margin:12px 0 6px}.msg-body h3{font-size:14px;font-weight:600;margin:10px 0 5px}
.msg-body ul,.msg-body ol{padding-left:22px;margin:7px 0}.msg-body li{margin:3px 0}
.msg-body a{color:var(--ac);text-decoration:none}.msg-body a:hover{text-decoration:underline}
.msg-body strong{font-weight:600}.msg-body em{font-style:italic}
.msg-body blockquote{border-left:3px solid var(--bd2);padding-left:12px;color:var(--tx2);margin:8px 0}
.msg-body hr{border:none;border-top:1px solid var(--bd);margin:12px 0}
.msg-body code{font-family:ui-monospace,'SF Mono',monospace;font-size:12.5px;background:var(--code);border:1px solid var(--bd);padding:1px 5px;border-radius:4px}
.msg-body pre{background:var(--code);border:1px solid var(--bd);border-radius:var(--r);padding:12px 14px;overflow-x:auto;margin:10px 0}
.msg-body pre code{background:none;border:none;padding:0;font-size:12.5px;line-height:1.55}
.cursor{display:inline-block;width:2px;height:1em;background:var(--ac);margin-left:2px;vertical-align:text-bottom;animation:blink .7s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.msg-acts{display:flex;gap:6px;margin-top:4px;opacity:0;transition:opacity .14s}.msg.asst:hover .msg-acts{opacity:1}
.mac-btn{font-size:11px;padding:3px 8px;border-radius:5px;border:1px solid var(--bd);background:var(--sf);color:var(--tx3);cursor:pointer;font-family:inherit;transition:color .12s}
.mac-btn:hover{color:var(--tx)}
.tool-row{padding:6px 0}
.tool-blk{background:var(--sf2);border:1px solid var(--bd);border-radius:var(--r);overflow:hidden;font-family:ui-monospace,'SF Mono',monospace;font-size:12px}
.tool-hdr{display:flex;align-items:center;gap:7px;padding:7px 12px;background:var(--sf);border-bottom:1px solid var(--bd)}
.tool-fn{font-weight:700;color:var(--ac)}.tool-stat{margin-left:auto;font-size:11px;font-weight:700}.tool-stat.ok{color:#4BA87A}.tool-stat.er{color:#E05555}
.tool-inner{padding:9px 12px;display:flex;flex-direction:column;gap:6px}
.tool-args{color:var(--tx2);white-space:pre-wrap;word-break:break-all;line-height:1.45}
.tool-result{color:var(--tx);border-top:1px solid var(--bd);padding-top:6px;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow-y:auto}
.tool-result::before{content:'→ ';color:var(--tx3)}
.think-row{display:flex;align-items:center;gap:10px;padding:14px 0 14px 14px;border-left:2px solid var(--ac)}
.dots{display:flex;gap:5px}.dots span{width:5px;height:5px;border-radius:50%;background:var(--ac);animation:dot 1.2s ease-in-out infinite}
.dots span:nth-child(2){animation-delay:.16s}.dots span:nth-child(3){animation-delay:.32s}
@keyframes dot{0%,80%,100%{transform:scale(.5);opacity:.25}40%{transform:scale(1);opacity:1}}
.think-txt{font-size:13px;color:var(--tx3)}
.reason-blk{border:1px solid var(--bd);border-radius:var(--r);overflow:hidden;margin:6px 0}
.reason-hdr{display:flex;align-items:center;gap:7px;padding:6px 12px;cursor:pointer;color:var(--tx3);font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;background:var(--sf2);user-select:none}
.reason-hdr:hover{color:var(--tx2)}.reason-arr{transition:transform .2s}.reason-hdr.open .reason-arr{transform:rotate(90deg)}
.reason-body{padding:10px 12px;font-size:12.5px;line-height:1.6;color:var(--tx2);display:none;white-space:pre-wrap;font-family:ui-monospace,monospace;border-top:1px solid var(--bd)}
.reason-hdr.open+.reason-body{display:block}
.inp-area{background:var(--sf);border-top:1px solid var(--bd);padding:12px 20px 14px;flex-shrink:0}
.err-bar{max-width:760px;margin:0 auto 10px;background:rgba(255,80,80,.1);border:1px solid rgba(255,80,80,.25);color:#FF7575;font-size:13px;padding:7px 14px;border-radius:var(--r);display:none}
.err-bar.on{display:block}
.inp-box{max-width:760px;margin:0 auto;display:flex;gap:10px;align-items:flex-end;background:var(--sf2);border:1px solid var(--bd);border-radius:var(--rl);padding:10px 10px 10px 14px;transition:border-color .15s}
.inp-box:focus-within{border-color:var(--ac)}
textarea.tinp{flex:1;background:none;border:none;outline:none;color:var(--tx);font-family:inherit;font-size:14px;line-height:1.55;resize:none;min-height:24px;max-height:200px;overflow-y:auto}
textarea.tinp::placeholder{color:var(--tx3)}
.sbtn{width:32px;height:32px;border-radius:var(--r);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .14s}
.sbtn.send{background:var(--ac)}.sbtn.send:hover{background:var(--ac2)}
.sbtn.stop{background:rgba(220,60,60,.15);border:1px solid rgba(220,60,60,.3)}.sbtn.stop:hover{background:rgba(220,60,60,.25)}
.sbtn:disabled{opacity:.35;cursor:not-allowed}
.inp-hint{text-align:center;font-size:11px;color:var(--tx3);margin-top:7px;max-width:760px;margin-left:auto;margin-right:auto}
.rules-chip{font-size:10.5px;color:var(--tx3);font-weight:600}
.rules-chip b{color:var(--ac)}
/* Skill autocomplete */
.skill-menu{max-width:760px;margin:0 auto 8px;background:var(--sf);border:1px solid var(--bd2);border-radius:var(--r);overflow:hidden;display:none;box-shadow:0 -8px 30px rgba(0,0,0,.3)}
.skill-menu.on{display:block}
.skill-item{padding:8px 14px;cursor:pointer;border-bottom:1px solid var(--bd);display:flex;flex-direction:column;gap:2px}
.skill-item:last-child{border-bottom:none}
.skill-item:hover,.skill-item.sel{background:var(--ac-bg)}
.skill-item .sn{font-size:13px;font-weight:700;color:var(--ac);font-family:ui-monospace,monospace}
.skill-item .sd{font-size:12px;color:var(--tx2)}
/* Config panel */
.cfg-modal{width:640px;max-width:calc(100vw - 24px);max-height:86vh;display:flex;flex-direction:column;padding:0}
.cfg-head{display:flex;align-items:center;gap:6px;padding:16px 20px;border-bottom:1px solid var(--bd)}
.cfg-head h2{font-size:15px;font-weight:600;flex:1}
.cfg-tabs{display:flex;gap:2px;padding:10px 20px 0}
.cfg-tab{border:none;background:none;color:var(--tx3);font-family:inherit;font-size:13px;font-weight:600;padding:7px 14px;border-radius:6px 6px 0 0;cursor:pointer;border-bottom:2px solid transparent}
.cfg-tab.on{color:var(--tx);border-bottom-color:var(--ac)}
.cfg-body{flex:1;overflow-y:auto;padding:14px 20px 20px}
.cfg-item{border:1px solid var(--bd);border-radius:var(--r);margin-bottom:12px;overflow:hidden}
.cfg-item-hd{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--sf2);border-bottom:1px solid var(--bd)}
.cfg-item-hd input{flex:1;background:none;border:none;color:var(--tx);font-family:ui-monospace,monospace;font-size:13px;font-weight:700;outline:none}
.cfg-item-hd .sk-pre{color:var(--ac);font-family:ui-monospace,monospace;font-size:13px;font-weight:700}
.cfg-item textarea{width:100%;background:var(--code);border:none;color:var(--tx);font-family:ui-monospace,monospace;font-size:12.5px;line-height:1.55;padding:10px 12px;resize:vertical;min-height:80px;outline:none;display:block}
.cfg-del{background:none;border:1px solid var(--bd);color:var(--tx3);border-radius:5px;padding:3px 9px;font-size:11px;cursor:pointer;font-family:inherit}
.cfg-del:hover{color:#E05555;border-color:#E05555}
.cfg-foot{display:flex;gap:10px;padding:14px 20px;border-top:1px solid var(--bd);align-items:center}
.cfg-add{background:var(--sf2);border:1px dashed var(--bd2);color:var(--tx2);border-radius:var(--r);padding:8px;font-family:inherit;font-size:13px;cursor:pointer;width:100%}
.cfg-add:hover{color:var(--tx);border-color:var(--ac)}
.cfg-saved{font-size:12px;color:#4BA87A;margin-left:auto;opacity:0;transition:opacity .2s}
.cfg-saved.on{opacity:1}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(6px)}
.overlay.off{display:none}
.modal{background:var(--sf);border:1px solid var(--bd2);border-radius:var(--rl);padding:26px;width:390px;max-width:calc(100vw - 32px);box-shadow:0 28px 70px rgba(0,0,0,.55)}
.modal h2{font-size:15px;font-weight:600;margin-bottom:5px}
.modal .sub{font-size:13px;color:var(--tx2);margin-bottom:18px;line-height:1.5}
.f-lbl{display:block;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--tx3);margin-bottom:6px}
.f-inp{width:100%;background:var(--sf2);border:1px solid var(--bd);color:var(--tx);padding:9px 12px;border-radius:var(--r);font-size:13px;font-family:ui-monospace,monospace;outline:none;margin-bottom:18px}
.f-inp:focus{border-color:var(--ac)}
.modal-acts{display:flex;gap:10px;justify-content:flex-end}
.btn{padding:7px 16px;border-radius:var(--r);font-size:13px;font-weight:500;cursor:pointer;border:none;font-family:inherit}
.btn-p{background:var(--ac);color:#fff}.btn-p:hover{background:var(--ac2)}
.btn-s{background:var(--sf2);color:var(--tx2);border:1px solid var(--bd)}.btn-s:hover{color:var(--tx)}
@media(prefers-reduced-motion:reduce){.cursor,.dots span{animation:none;opacity:1}*{transition:none!important}}
</style>
</head>
<body>

<div class="overlay off" id="keyOverlay">
  <div class="modal">
    <h2>OpenRouter API Key</h2>
    <p class="sub">Stored in localStorage — sent only to OpenRouter.</p>
    <label class="f-lbl" for="ki">API Key</label>
    <input type="password" class="f-inp" id="ki" placeholder="sk-or-v1-…" autocomplete="off">
    <div class="modal-acts">
      <button class="btn btn-s" id="cancelKey">Cancel</button>
      <button class="btn btn-p" id="saveKey">Save</button>
    </div>
  </div>
</div>

<header class="hdr">
  <div class="logo">Open<em>·</em>Agent</div>
  <div class="mdl-wrap">
    <select class="mdl-sel" id="modelSel">
      <optgroup label="💻 Local (Ollama)" id="localGroup"></optgroup>
      <optgroup label="⭐ Free">
        <option value="meta-llama/llama-3.3-70b-instruct:free">Llama 3.3 70B (free)</option>
        <option value="deepseek/deepseek-r1:free">DeepSeek R1 (free)</option>
        <option value="deepseek/deepseek-chat-v3-0324:free">DeepSeek V3 (free)</option>
        <option value="qwen/qwen3-235b-a22b:free">Qwen3 235B (free)</option>
        <option value="microsoft/phi-4:free">Phi-4 (free)</option>
        <option value="mistralai/mistral-7b-instruct:free">Mistral 7B (free)</option>
      </optgroup>
      <optgroup label="Anthropic">
        <option value="anthropic/claude-opus-4">Claude Opus 4</option>
        <option value="anthropic/claude-sonnet-4-5">Claude Sonnet 4.5</option>
        <option value="anthropic/claude-haiku-4-5">Claude Haiku 4.5</option>
      </optgroup>
      <optgroup label="OpenAI">
        <option value="openai/gpt-4o">GPT-4o</option>
        <option value="openai/gpt-4o-mini" selected>GPT-4o mini</option>
        <option value="openai/o4-mini">o4-mini</option>
      </optgroup>
      <optgroup label="Google">
        <option value="google/gemini-2.5-pro">Gemini 2.5 Pro</option>
        <option value="google/gemini-2.5-flash">Gemini 2.5 Flash</option>
      </optgroup>
      <optgroup label="Mistral">
        <option value="mistralai/mistral-large">Mistral Large</option>
      </optgroup>
      <optgroup label="DeepSeek">
        <option value="deepseek/deepseek-chat-v3-0324">DeepSeek V3</option>
        <option value="deepseek/deepseek-r1">DeepSeek R1</option>
      </optgroup>
    </select>
    <div class="cwd-chip" id="cwdChip">~</div>
  </div>
  <div class="hdr-btns">
    <div class="mode-tog" id="modeTog" role="tablist" aria-label="Mode">
      <button class="mode-opt on" id="modeChat" role="tab" aria-selected="true">Chat</button>
      <button class="mode-opt" id="modeAgent" role="tab" aria-selected="false">Agent</button>
    </div>
    <button class="ibtn" id="cfgBtn" title="Rules &amp; Skills">
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M3 2.5h9M3 5.5h9M3 8.5h6M3 11.5h6" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><circle cx="11.5" cy="10.5" r="2.2" stroke="currentColor" stroke-width="1.2"/></svg>
    </button>
    <button class="ibtn" id="keyBtn" title="API Key">
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><circle cx="9.5" cy="5" r="3.5" stroke="currentColor" stroke-width="1.35"/><path d="M6.2 7.8L2 12" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><path d="M3.5 12.5v-1.5h1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button class="ibtn" id="clearBtn" title="Clear">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 3.5h12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M4.5 3.5V2.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5v1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M11 3.5l-.65 7.8A1 1 0 019.35 12H4.65a1 1 0 01-.99-.7L3 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button class="ibtn" id="themeBtn" title="Theme">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" id="themeIco"><path d="M7 1v1M7 12v1M1 7h1M12 7h1M2.7 2.7l.7.7M10.6 10.6l.7.7M2.7 11.3l.7-.7M10.6 3.4l.7-.7M4.5 7a2.5 2.5 0 105 0 2.5 2.5 0 00-5 0z" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>
    </button>
  </div>
</header>

<main class="chat" id="chat">
  <div class="msgs" id="msgs">
    <div class="empty" id="emptyState">
      <svg width="44" height="44" viewBox="0 0 44 44" fill="none"><rect x="3" y="7" width="38" height="30" rx="5" stroke="currentColor" stroke-width="1.8"/><path d="M11 18h22M11 26h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      <h2>OpenRouter</h2>
      <p><strong>Chat</strong> — a normal streaming conversation with any model.<br><br><strong>Agent</strong> — full terminal &amp; file access: it can run commands, read and write files, and navigate your filesystem.<br><br>Switch between them with the toggle in the header.</p>
    </div>
  </div>
</main>

<footer class="inp-area">
  <div class="err-bar" id="errBar"></div>
  <div class="skill-menu" id="skillMenu"></div>
  <div class="inp-box">
    <textarea class="tinp" id="tinp" rows="1" placeholder="Ask the agent…"></textarea>
    <button class="sbtn send" id="sbtn" disabled>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" id="sbtnIco"><path d="M13 8H3M13 8L8.5 3.5M13 8l-4.5 4.5" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>
  <p class="inp-hint"><span id="rulesChip" class="rules-chip"></span> · Type <b>/</b> for skills · Enter to send · Shift+Enter = newline</p>
</footer>

<!-- Rules & Skills manager -->
<div class="overlay off" id="cfgOverlay">
  <div class="modal cfg-modal">
    <div class="cfg-head">
      <h2>Rules &amp; Skills</h2>
      <button class="btn btn-s" id="cfgClose">Done</button>
    </div>
    <div class="cfg-tabs">
      <button class="cfg-tab on" id="tabRules">Rules</button>
      <button class="cfg-tab" id="tabSkills">Skills</button>
    </div>
    <div class="cfg-body" id="cfgBody"></div>
    <div class="cfg-foot">
      <button class="cfg-add" id="cfgAdd">+ Add</button>
      <span class="cfg-saved" id="cfgSaved">Saved ✓</span>
    </div>
  </div>
</div>

<script>
const BASE = '';
let apiKey = localStorage.getItem('or_key') || '';
let messages = [], busy = false, ctrl = null;
let mode = localStorage.getItem('or_mode') || 'chat';
let rules = [], skills = [];
const notes = new Map();

const $  = id => document.getElementById(id);
const modelSel = $('modelSel'), keyBtn = $('keyBtn'), clearBtn = $('clearBtn');
const themeBtn = $('themeBtn'), keyOverlay = $('keyOverlay'), ki = $('ki');
const cancelKey = $('cancelKey'), saveKeyBtn = $('saveKey');
const chat = $('chat'), msgs = $('msgs'), emptyState = $('emptyState');
const errBar = $('errBar'), tinp = $('tinp'), sbtn = $('sbtn'), cwdChip = $('cwdChip');
const modeChat = $('modeChat'), modeAgent = $('modeAgent');

// Mode toggle
function applyMode(){
  const agent = mode === 'agent';
  modeChat.classList.toggle('on', !agent);
  modeAgent.classList.toggle('on', agent);
  modeChat.setAttribute('aria-selected', !agent);
  modeAgent.setAttribute('aria-selected', agent);
  cwdChip.style.display = agent ? '' : 'none';
  tinp.placeholder = agent ? 'Ask the agent…' : 'Message…';
  localStorage.setItem('or_mode', mode);
}
modeChat.addEventListener('click', ()=>{ if(busy)return; mode='chat'; applyMode(); });
modeAgent.addEventListener('click', ()=>{ if(busy)return; mode='agent'; applyMode(); });
applyMode();

// Theme
const sv = localStorage.getItem('or_theme');
if (sv) document.documentElement.dataset.theme = sv;
function isDark(){ const t=document.documentElement.dataset.theme; return t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches); }
function syncThemeIcon(){ $('themeIco').innerHTML = isDark() ? '<path d="M7 1v1M7 12v1M1 7h1M12 7h1M2.7 2.7l.7.7M10.6 10.6l.7.7M2.7 11.3l.7-.7M10.6 3.4l.7-.7M4.5 7a2.5 2.5 0 105 0 2.5 2.5 0 00-5 0z" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>' : '<path d="M11.5 7.5A5 5 0 016.5 2.5a4.5 4.5 0 100 9 5 5 0 005-4z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'; }
syncThemeIcon();
themeBtn.addEventListener('click', () => { const n=isDark()?'light':'dark'; document.documentElement.dataset.theme=n; localStorage.setItem('or_theme',n); syncThemeIcon(); });

// CWD
async function refreshCwd(){ try{ const r=await fetch(BASE+'/cwd'); const d=await r.json(); cwdChip.textContent=d.cwd.replace(new RegExp('^'+location.host),'').replace(/^\/Users\/\w+/,'~'); cwdChip.title=d.cwd; } catch{} }
refreshCwd();

// Load locally-installed Ollama models into the dropdown
function isLocal(model){ return model.startsWith('ollama:'); }
async function loadLocalModels(){
  try{
    const r = await fetch(BASE+'/local/models');
    const d = await r.json();
    const grp = document.getElementById('localGroup');
    if(!d.models || !d.models.length){ grp.remove(); return; }
    grp.innerHTML = d.models.map(m=>'<option value="ollama:'+m+'">'+m+' (local)</option>').join('');
  }catch{ document.getElementById('localGroup')?.remove(); }
}
loadLocalModels();

// ── Rules & Skills ────────────────────────────────────────────────
async function loadConfig(){
  try{
    const r = await fetch(BASE+'/config'); const d = await r.json();
    rules = d.rules||[]; skills = d.skills||[];
  }catch{ rules=[]; skills=[]; }
  updateRulesChip();
}
function updateRulesChip(){
  const active = rules.filter(r=>r.content.trim()).length;
  $('rulesChip').innerHTML = active ? '<b>'+active+'</b> rule'+(active>1?'s':'')+' active' : 'No rules';
}
function rulesText(){ return rules.map(r=>r.content.trim()).filter(Boolean).join('\n\n'); }
function buildSystem(isAgent, skillBody){
  const parts=[];
  const rt=rulesText(); if(rt) parts.push(rt);
  if(isAgent) parts.push(SYS);
  if(skillBody) parts.push('## Active skill\n'+skillBody);
  return parts.join('\n\n');
}
function extractSkill(text){
  const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  if(!m) return null;
  const sk = skills.find(s=>s.name===m[1]);
  return sk ? { skill: sk, rest: m[2].trim() } : null;
}
loadConfig();

// ── Skill autocomplete menu ───────────────────────────────────────
const skillMenu = $('skillMenu');
let skillSel = 0, skillMatches = [];
function updateSkillMenu(){
  const v = tinp.value;
  const m = v.match(/^\/(\w*)$/);
  if(!m || !skills.length){ skillMenu.classList.remove('on'); skillMatches=[]; return; }
  const q = m[1].toLowerCase();
  skillMatches = skills.filter(s=>s.name.toLowerCase().includes(q));
  if(!skillMatches.length){ skillMenu.classList.remove('on'); return; }
  skillSel = Math.min(skillSel, skillMatches.length-1);
  skillMenu.innerHTML = skillMatches.map((s,i)=>
    '<div class="skill-item'+(i===skillSel?' sel':'')+'" data-i="'+i+'"><span class="sn">/'+esc(s.name)+'</span><span class="sd">'+esc(s.description||'')+'</span></div>').join('');
  skillMenu.classList.add('on');
  skillMenu.querySelectorAll('.skill-item').forEach(el=>{
    el.addEventListener('click',()=>pickSkill(+el.dataset.i));
  });
}
function pickSkill(i){
  const s = skillMatches[i]; if(!s) return;
  tinp.value = '/'+s.name+' ';
  skillMenu.classList.remove('on'); skillMatches=[];
  tinp.focus(); sbtn.disabled=false;
}

// ── Config modal ──────────────────────────────────────────────────
const cfgOverlay=$('cfgOverlay'), cfgBody=$('cfgBody'), cfgSaved=$('cfgSaved');
let cfgTab='rule';
$('cfgBtn').addEventListener('click', async ()=>{ await loadConfig(); cfgTab='rule'; setTab(); cfgOverlay.classList.remove('off'); });
$('cfgClose').addEventListener('click', ()=>{ cfgOverlay.classList.add('off'); });
cfgOverlay.addEventListener('click', e=>{ if(e.target===cfgOverlay) cfgOverlay.classList.add('off'); });
$('tabRules').addEventListener('click', ()=>{ cfgTab='rule'; setTab(); });
$('tabSkills').addEventListener('click', ()=>{ cfgTab='skill'; setTab(); });
function setTab(){
  $('tabRules').classList.toggle('on', cfgTab==='rule');
  $('tabSkills').classList.toggle('on', cfgTab==='skill');
  renderCfg();
}
function renderCfg(){
  const items = cfgTab==='rule' ? rules : skills;
  cfgBody.innerHTML = '';
  items.forEach(it=>{
    const content = cfgTab==='rule' ? it.content
      : '---\ndescription: '+(it.description||'')+'\n---\n'+it.body;
    const wrap=document.createElement('div'); wrap.className='cfg-item';
    wrap.innerHTML =
      '<div class="cfg-item-hd">'+(cfgTab==='skill'?'<span class="sk-pre">/</span>':'')+
      '<input value="'+esc(it.name)+'" data-orig="'+esc(it.name)+'"></div>'+
      '<textarea>'+esc(content)+'</textarea>'+
      '<div style="padding:8px 12px;display:flex;gap:8px;background:var(--sf2);border-top:1px solid var(--bd)">'+
      '<button class="btn btn-p cfg-save" style="padding:5px 14px;font-size:12px">Save</button>'+
      '<button class="cfg-del">Delete</button></div>';
    const nameEl=wrap.querySelector('input'), taEl=wrap.querySelector('textarea');
    wrap.querySelector('.cfg-save').addEventListener('click',()=>saveCfg(nameEl.value, taEl.value, nameEl.dataset.orig));
    wrap.querySelector('.cfg-del').addEventListener('click',()=>delCfg(nameEl.dataset.orig));
    cfgBody.appendChild(wrap);
  });
}
async function saveCfg(name, content, orig){
  name=(name||'').trim().replace(/[^a-zA-Z0-9._-]/g,'');
  if(!name) return;
  if(orig && orig!==name){ await fetch(BASE+'/config/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:cfgTab,name:orig})}); }
  await fetch(BASE+'/config/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:cfgTab,name,content})});
  cfgSaved.classList.add('on'); setTimeout(()=>cfgSaved.classList.remove('on'),1400);
  await loadConfig(); renderCfg();
}
async function delCfg(name){
  await fetch(BASE+'/config/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:cfgTab,name})});
  await loadConfig(); renderCfg();
}
$('cfgAdd').addEventListener('click', async ()=>{
  const base = cfgTab==='rule' ? 'new-rule' : 'new-skill';
  let n=base, i=1; const names=(cfgTab==='rule'?rules:skills).map(x=>x.name);
  while(names.includes(n)){ n=base+'-'+(++i); }
  const tmpl = cfgTab==='rule' ? '# '+n+'\n- ' : '---\ndescription: what this skill does\n---\nInstructions for the skill…';
  await saveCfg(n, tmpl, null);
});

// API key
function openKeyModal(){ ki.value=''; keyOverlay.classList.remove('off'); setTimeout(()=>ki.focus(),60); }
function closeKeyModal(){ keyOverlay.classList.add('off'); }
keyBtn.addEventListener('click', openKeyModal);
cancelKey.addEventListener('click', closeKeyModal);
keyOverlay.addEventListener('click', e=>{ if(e.target===keyOverlay) closeKeyModal(); });
saveKeyBtn.addEventListener('click', ()=>{ const v=ki.value.trim(); if(v){apiKey=v;localStorage.setItem('or_key',v);} closeKeyModal(); hideErr(); });
ki.addEventListener('keydown', e=>{ if(e.key==='Enter') saveKeyBtn.click(); if(e.key==='Escape') closeKeyModal(); });

// Input
tinp.addEventListener('input', ()=>{ tinp.style.height='auto'; tinp.style.height=Math.min(tinp.scrollHeight,200)+'px'; if(!busy) sbtn.disabled=!tinp.value.trim(); updateSkillMenu(); });
tinp.addEventListener('keydown', e=>{
  if(skillMenu.classList.contains('on') && skillMatches.length){
    if(e.key==='ArrowDown'){ e.preventDefault(); skillSel=(skillSel+1)%skillMatches.length; updateSkillMenu(); return; }
    if(e.key==='ArrowUp'){ e.preventDefault(); skillSel=(skillSel-1+skillMatches.length)%skillMatches.length; updateSkillMenu(); return; }
    if(e.key==='Tab' || (e.key==='Enter'&&!e.shiftKey)){ e.preventDefault(); pickSkill(skillSel); return; }
    if(e.key==='Escape'){ skillMenu.classList.remove('on'); skillMatches=[]; return; }
  }
  if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); if(busy) stopStream(); else if(!sbtn.disabled) send(); }
});
sbtn.addEventListener('click', ()=>busy?stopStream():send());

function setSend(){ busy=false; sbtn.className='sbtn send'; sbtn.disabled=!tinp.value.trim(); $('sbtnIco').innerHTML='<path d="M13 8H3M13 8L8.5 3.5M13 8l-4.5 4.5" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'; }
function setStop(){ busy=true; sbtn.className='sbtn stop'; sbtn.disabled=false; const i=$('sbtnIco'); i.innerHTML=''; const r=document.createElementNS('http://www.w3.org/2000/svg','rect'); r.setAttribute('x','4');r.setAttribute('y','4');r.setAttribute('width','8');r.setAttribute('height','8');r.setAttribute('rx','1.5');r.setAttribute('fill','#FF7575'); i.appendChild(r); }
function stopStream(){ ctrl&&ctrl.abort(); }

async function send(){
  const raw = tinp.value.trim(); if(!raw) return;
  if(!apiKey && !isLocal(modelSel.value)){ openKeyModal(); return; }
  tinp.value=''; tinp.style.height='auto'; skillMenu.classList.remove('on'); setStop(); hideErr();
  const ex = extractSkill(raw);
  const skillBody = ex ? ex.skill.body : null;
  const content = ex ? (ex.rest || ('Apply the /'+ex.skill.name+' skill.')) : raw;
  if(mode==='agent') await runAgent(content, skillBody);
  else await runChat(content, skillBody);
  setSend();
}

// ── Chat mode (streaming) ─────────────────────────────────────────
const FALLBACK_MODEL = 'openai/gpt-4o-mini';

// OpenRouter buries rate-limit info: message may be a generic "Provider returned error",
// with the real signal in error.code (429) or error.metadata.raw ("temporarily rate-limited").
function isRateLimit(err){
  if(!err) return false;
  if(err===429) return true;
  const s = typeof err==='string' ? err
    : [err.message, err.code, err.raw, err.status].filter(Boolean).join(' ');
  return /rate.?limit|429|temporarily|quota|too many/i.test(s);
}
// Parse an OpenRouter error response into an Error carrying code + raw for detection.
function orError(json, status){
  const e = json?.error || {};
  const err = new Error(e.message || ('HTTP '+status));
  err.code = e.code; err.status = status; err.raw = e.metadata?.raw || '';
  return err;
}

async function runChat(content, skillBody){
  const sys = buildSystem(false, skillBody);
  messages.push({role:'user',content});
  appendMsg('user',content,'You');
  const row = appendMsg('asst','',modelSel.options[modelSel.selectedIndex].text.replace(/ \((free|local)\)$/,''));
  const body = row.querySelector('.msg-body');
  row.classList.add('live');
  ctrl = new AbortController();

  // Try the selected model; if a free model is rate-limited, fall back automatically.
  let model = modelSel.value;
  let triedFallback = false;

  while(true){
    let full = '';
    try{
      const local = isLocal(model);
      const res = await fetch(local ? BASE+'/local/chat' : 'https://openrouter.ai/api/v1/chat/completions',{
        method:'POST', signal:ctrl.signal,
        headers: local
          ? {'Content-Type':'application/json'}
          : {'Authorization':'Bearer '+apiKey,'Content-Type':'application/json','HTTP-Referer':location.href,'X-Title':'OpenRouter Chat'},
        body:JSON.stringify({model: local ? model.slice(7) : model, messages: sys ? [{role:'system',content:sys},...messages] : messages, stream:true})
      });
      if(!res.ok){ const j=await res.json().catch(()=>({})); throw orError(j, res.status); }

      const reader = res.body.getReader(), dec = new TextDecoder();
      let done = false, buf = '';
      while(!done){
        const {done:d,value} = await reader.read(); if(d) break;
        buf += dec.decode(value,{stream:true});
        const lines = buf.split('\n'); buf = lines.pop();
        for(const line of lines){
          const s = line.trim();
          if(!s.startsWith('data: ')) continue;
          const raw = s.slice(6).trim();
          if(raw==='[DONE]'){ done=true; break; }
          try{
            const j = JSON.parse(raw);
            if(j.error) throw new Error(j.error.message||'stream error');
            const delta = j.choices?.[0]?.delta?.content;
            if(delta){ full+=delta; body.innerHTML=renderMd(full)+'<span class="cursor"></span>'; scroll(); }
          }catch(e){ if(e.message && isRateLimit(e.message)) throw e; }
        }
      }
      body.innerHTML = renderMd(full);
      row.classList.remove('live');
      messages.push({role:'assistant',content:full});
      addCopy(row,full);
      return scroll();

    }catch(err){
      if(err.name==='AbortError'){
        if(full){ body.innerHTML=renderMd(full); row.classList.remove('live'); messages.push({role:'assistant',content:full}); addCopy(row,full); }
        else { row.remove(); messages.pop(); }
        return scroll();
      }
      // Auto-fallback: free model rate-limited → retry once with a paid model that works.
      if(isRateLimit(err) && model.includes(':free') && !triedFallback){
        triedFallback = true;
        model = FALLBACK_MODEL;
        body.innerHTML = '<em style="color:var(--tx3)">Free model is rate-limited — retrying with GPT-4o mini…</em>';
        row.querySelector('.msg-lbl').textContent = 'GPT-4o mini';
        scroll();
        continue;
      }
      row.remove(); messages.pop();
      showErr(isRateLimit(err)
        ? 'Model rate-limited. Pick GPT-4o mini from the dropdown (needs OpenRouter credit) or wait a moment.'
        : err.message);
      return scroll();
    }
  }
}

// ── Tools ─────────────────────────────────────────────────────────
const TOOLS = [
  {type:'function',function:{name:'run_command',description:'Execute a shell command on the local machine. Supports cd to change directory.',parameters:{type:'object',properties:{command:{type:'string',description:'Shell command to run'}},required:['command']}}},
  {type:'function',function:{name:'read_file',description:'Read the contents of a file.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}},
  {type:'function',function:{name:'write_file',description:'Write content to a file, creating it if needed.',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']}}},
  {type:'function',function:{name:'list_directory',description:'List files and directories at a path.',parameters:{type:'object',properties:{path:{type:'string',description:'Path relative to cwd, or absolute. Default: current directory.'}},required:[]}}},
  {type:'function',function:{name:'calculate',description:'Evaluate a math expression.',parameters:{type:'object',properties:{expression:{type:'string'}},required:['expression']}}},
  {type:'function',function:{name:'get_datetime',description:'Get current date and time.',parameters:{type:'object',properties:{}}}},
  {type:'function',function:{name:'take_note',description:'Store a note.',parameters:{type:'object',properties:{key:{type:'string'},value:{type:'string'}},required:['key','value']}}},
  {type:'function',function:{name:'get_note',description:'Retrieve a stored note.',parameters:{type:'object',properties:{key:{type:'string'}},required:['key']}}},
];

async function executeTool(name, args){
  if(name==='run_command'){
    const r = await fetch(BASE+'/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:args.command})});
    const d = await r.json();
    if(d.error) return 'Error: '+d.error;
    let out = '';
    if(d.stdout) out += d.stdout;
    if(d.stderr) out += (out?'\n[stderr] ':'')+d.stderr;
    if(!out) out = '(no output)';
    if(d.cwd) await refreshCwd();
    return out.trim();
  }
  if(name==='read_file'){
    const r = await fetch(BASE+'/fs/read',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:args.path})});
    const d = await r.json(); return d.error ? 'Error: '+d.error : d.content;
  }
  if(name==='write_file'){
    const r = await fetch(BASE+'/fs/write',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:args.path,content:args.content})});
    const d = await r.json(); return d.error ? 'Error: '+d.error : 'Written to '+d.path;
  }
  if(name==='list_directory'){
    const r = await fetch(BASE+'/fs/list',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:args.path||'.'})});
    const d = await r.json();
    if(d.error) return 'Error: '+d.error;
    if(!d.entries.length) return '(empty directory) '+d.path;
    return d.path+'\n'+d.entries.map(e=>(e.type==='dir'?'📁 ':'📄 ')+e.name).join('\n');
  }
  if(name==='calculate'){
    try{ return String(safeCalc(String(args.expression))); } catch(e){ return 'Error: '+e.message; }
  }
  if(name==='get_datetime') return new Date().toLocaleString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'});
  if(name==='take_note'){ notes.set(String(args.key),String(args.value)); return 'Saved.'; }
  if(name==='get_note') return notes.get(String(args.key)) || 'No note for key "'+args.key+'"';
  return 'Unknown tool';
}

function safeCalc(e){
  const p=e.replace(/\^/g,'**').replace(/\bsqrt\b/g,'Math.sqrt').replace(/\babs\b/g,'Math.abs').replace(/\bround\b/g,'Math.round').replace(/\bfloor\b/g,'Math.floor').replace(/\bceil\b/g,'Math.ceil').replace(/\blog2\b/g,'Math.log2').replace(/\blog10\b/g,'Math.log10').replace(/\blog\b/g,'Math.log').replace(/\bsin\b/g,'Math.sin').replace(/\bcos\b/g,'Math.cos').replace(/\btan\b/g,'Math.tan').replace(/\bpow\b/g,'Math.pow').replace(/\bmin\b/g,'Math.min').replace(/\bmax\b/g,'Math.max').replace(/\bPI\b|\bpi\b/g,'Math.PI').replace(/\bE\b/g,'Math.E');
  const s=p.replace(/Math\.\w+/g,'X').replace(/\s/g,'');
  if(/[^0-9\+\-\*\/\(\)\.,X%]/.test(s)) throw new Error('invalid expression');
  return Function('"use strict";return('+p+')')();
}

// ── Agent loop ────────────────────────────────────────────────────
const SYS = 'You are a local system agent running on the user\'s Mac. You have full shell access via run_command. Use tools decisively — run commands, read files, list directories. Never ask permission before using tools. Show the user what you find. Be direct and efficient.';

async function runAgent(content, skillBody){
  const sys = buildSystem(true, skillBody);
  messages.push({role:'user',content});
  appendMsg('user',content,'You');
  ctrl = new AbortController();
  const label = modelSel.options[modelSel.selectedIndex].text.replace(/ \((free|local)\)$/,'');
  const MAX = 12; let iter = 0;
  let model = modelSel.value, triedFallback = false;

  while(iter++ < MAX){
    const slow=/(^|\/|-)(o1|o3|o4|r1|qwq|reasoning|thinking)(-|:|$)/i.test(model);
    const thinking = appendThinking(iter===1?(slow?'Thinking (reasoning model — be patient)…':'Thinking…'):'Working…');
    try{
      const local = isLocal(model);
      const res = await fetch(local ? BASE+'/local/chat' : 'https://openrouter.ai/api/v1/chat/completions',{
        method:'POST', signal:ctrl.signal,
        headers: local
          ? {'Content-Type':'application/json'}
          : {'Authorization':'Bearer '+apiKey,'Content-Type':'application/json','HTTP-Referer':location.href,'X-Title':'OpenRouter Agent'},
        body:JSON.stringify({model: local ? model.slice(7) : model, messages:[{role:'system',content:sys},...messages],tools:TOOLS,tool_choice:'auto',stream:false})
      });
      thinking.remove();
      if(!res.ok){
        const j=await res.json().catch(()=>({}));
        const err = orError(j, res.status);
        if(isRateLimit(err) && model.includes(':free') && !triedFallback){
          triedFallback = true; model = FALLBACK_MODEL; iter--;
          const note = appendThinking('Free model rate-limited — switching to GPT-4o mini…');
          setTimeout(()=>note.remove(), 1500);
          continue;
        }
        throw err;
      }
      const data = await res.json();
      const choice = data.choices?.[0];
      if(!choice) throw new Error('no response');
      const msg = choice.message;
      if(msg.reasoning||msg.reasoning_content) appendReasoning(msg.reasoning||msg.reasoning_content);
      if(msg.tool_calls?.length){
        messages.push(msg);
        for(const tc of msg.tool_calls){
          let args={}; try{args=JSON.parse(tc.function?.arguments||'{}');}catch{}
          const thinking2 = appendThinking('Running: '+esc(tc.function.name)+'…');
          const result = await executeTool(tc.function.name, args).catch(e=>'Error: '+e.message);
          thinking2.remove();
          appendToolBlock(tc.function.name, args, result);
          messages.push({role:'tool',tool_call_id:tc.id,content:String(result)});
        }
      } else if(msg.content){
        messages.push({role:'assistant',content:msg.content});
        const row = appendMsg('asst',msg.content,label);
        addCopy(row,msg.content); break;
      } else { break; }
    }catch(err){
      thinking.remove();
      if(err.name!=='AbortError') showErr(err.message);
      break;
    }
  }
  scroll();
}

// ── DOM helpers ───────────────────────────────────────────────────
function appendMsg(role,content,label){
  emptyState.style.display='none';
  const row=document.createElement('div'); row.className='msg '+role;
  const lbl=document.createElement('div'); lbl.className='msg-lbl'; lbl.textContent=label||(role==='user'?'You':'Assistant');
  const body=document.createElement('div'); body.className='msg-body';
  if(role==='user') body.textContent=content;
  else body.innerHTML=renderMd(content);
  row.appendChild(lbl); row.appendChild(body); msgs.appendChild(row); scroll(); return row;
}
function appendThinking(text){
  const r=document.createElement('div'); r.className='think-row';
  r.innerHTML='<div class="dots"><span></span><span></span><span></span></div><span class="think-txt">'+esc(text)+'</span>';
  msgs.appendChild(r); scroll();
  // live elapsed-seconds counter so slow (reasoning) models never look frozen
  const txt=r.querySelector('.think-txt'); let s=0;
  const timer=setInterval(()=>{ s++; txt.textContent=text+' ('+s+'s'+(s>=20?' — reasoning models can take a minute':'')+')'; },1000);
  const origRemove=r.remove.bind(r);
  r.remove=()=>{ clearInterval(timer); origRemove(); };
  return r;
}
function appendToolBlock(name,args,result){
  emptyState.style.display='none';
  const isErr=String(result).startsWith('Error:');
  const row=document.createElement('div'); row.className='tool-row';
  row.innerHTML='<div class="tool-blk"><div class="tool-hdr"><span style="opacity:.6;font-size:11px">⚙</span><span class="tool-fn">'+esc(name)+'</span><span class="tool-stat '+(isErr?'er':'ok')+'">'+(isErr?'✗':'✓')+'</span></div><div class="tool-inner"><div class="tool-args">'+esc(JSON.stringify(args,null,2))+'</div><div class="tool-result">'+esc(String(result))+'</div></div></div>';
  msgs.appendChild(row); scroll();
}
function appendReasoning(text){
  const blk=document.createElement('div'); blk.className='reason-blk';
  const hdr=document.createElement('div'); hdr.className='reason-hdr';
  hdr.innerHTML='<span class="reason-arr">▶</span> Reasoning';
  hdr.addEventListener('click',()=>hdr.classList.toggle('open'));
  const body=document.createElement('div'); body.className='reason-body'; body.textContent=text;
  blk.appendChild(hdr); blk.appendChild(body); msgs.appendChild(blk); scroll();
}
function addCopy(row,text){
  const acts=document.createElement('div'); acts.className='msg-acts';
  const btn=document.createElement('button'); btn.className='mac-btn'; btn.textContent='Copy';
  btn.addEventListener('click',()=>{ navigator.clipboard.writeText(text).then(()=>{ btn.textContent='Copied'; setTimeout(()=>btn.textContent='Copy',1600); }); });
  acts.appendChild(btn); row.appendChild(acts);
}
function scroll(){ chat.scrollTop=chat.scrollHeight; }
function showErr(m){ errBar.textContent='Error: '+m; errBar.classList.add('on'); }
function hideErr(){ errBar.classList.remove('on'); }
clearBtn.addEventListener('click',()=>{ if(busy)return; messages=[]; notes.clear(); msgs.innerHTML=''; msgs.appendChild(emptyState); emptyState.style.display=''; hideErr(); refreshCwd(); });

// ── Markdown ──────────────────────────────────────────────────────
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function renderMd(raw){
  const blocks=[];
  let t=raw.replace(/\x60\x60\x60(\w*)\n?([\s\S]*?)\x60\x60\x60/g,(_,lang,code)=>{ const i=blocks.length; blocks.push('<pre><code>'+esc(code.trimEnd())+'</code></pre>'); return '\x02B'+i+'\x02'; });
  t=esc(t);
  t=t.replace(/\x60([^\x60\n]+)\x60/g,'<code>$1</code>');
  t=t.replace(/^(#{1,6})\s+(.+)$/gm,(_,h,txt)=>{ const n=Math.min(h.length,3); return '<h'+n+'>'+txt+'</h'+n+'>'; });
  t=t.replace(/^---+$/gm,'<hr>');
  t=t.replace(/((?:^&gt; .+\n?)+)/gm,m=>'<blockquote>'+m.replace(/^&gt; /gm,'').trim()+'</blockquote>');
  t=t.replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>');
  t=t.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  t=t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g,'<em>$1</em>');
  t=t.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  t=t.replace(/((?:^[ \t]*[-*+] [^\n]+\n?)+)/gm,m=>'<ul>'+m.trim().split('\n').map(l=>'<li>'+l.replace(/^[ \t]*[-*+]\s/,'').trim()+'</li>').join('')+'</ul>');
  t=t.replace(/((?:^[ \t]*\d+\.\s[^\n]+\n?)+)/gm,m=>'<ol>'+m.trim().split('\n').map(l=>'<li>'+l.replace(/^[ \t]*\d+\.\s/,'').trim()+'</li>').join('')+'</ol>');
  t=t.split(/\n\n+/).map(s=>{ s=s.trim(); if(!s) return ''; if(/^<(h[1-6]|ul|ol|pre|blockquote|hr|\x02)/.test(s)) return s; return '<p>'+s.replace(/\n/g,'<br>')+'</p>'; }).join('');
  t=t.replace(/\x02B(\d+)\x02/g,(_,i)=>blocks[+i]);
  return t;
}
</script>
</body>
</html>`;
