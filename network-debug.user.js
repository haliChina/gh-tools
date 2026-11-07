// ==UserScript==
// @name         Network Debug - 网络抓包日志（刷新不清除）
// @namespace    https://github.com/haliChina
// @version      1.2.0
// @description  拦截 fetch / XHR / 表单提交，记录 method、URL、请求头、请求体、状态码、响应片段，日志存到 GM 存储 + localStorage，刷新、跳转后还在，只有手动点“清空”才会删。专为抓 GitHub 删除仓库那类整页表单提交准备。
// @author       haliChina
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-start
// @license      MIT
// ==/UserScript==

/*
 * 为什么需要这个脚本：
 * 云端浏览器打不开 DevTools Network 面板，GitHub 删仓那次就没抓到
 * method / URL / authenticity_token 字段名。本脚本在页面里直接包一层
 * fetch / XHR / 表单提交，请求发出去之前先记一笔，写进持久存储，
 * 就算删仓是整页表单提交、跳走了，刷新回来日志也还在。
 *
 * 用法（抓 GitHub 删仓）：
 * 1. Tampermonkey 安装本脚本，打开 https://github.com/haliChina/<仓库名>/settings
 * 2. 右下角会出现 NetDebug 浮窗，确认右上角是录制中
 * 3. 正常走 Danger Zone 删除流程，删完跳回仓库列表页也别关
 * 4. 回到浮窗，过滤框搜 "delete" 或 "settings"，点那条记录展开，
 *    看 method / url / 请求体里有哪些字段（authenticity_token 的值默认打码，只看字段名就够了）
 * 5. 点“导出 JSON”保存一份，或点单条记录的“复制 cURL”拿去对照
 *
 * 持久化说明：
 * - 日志存在 GM_setValue（主）+ localStorage（备），键名见下面的 STORE_KEY
 * - 页面加载时只读出来渲染，绝不清空；刷新、跳转、关掉重开都在
 * - 只有点浮窗里的“清空”才会删；上限 300 条，超了删最旧的，每条请求体/响应各截断到 4000 字
 * - 敏感字段（authenticity_token / password / token / secret 等）的值默认打码，
 *   只留首尾 4 位，字段名完整保留；点“显示敏感值”可临时看全（仅当前页显示，不改已存日志）
 *
 * v1.1.0 UI 改动（只改 UI，不改抓包/存储/打码逻辑）：
 * Primer 风格浮窗（圆角 12px、柔和阴影、录制绿点呼吸动画）、深色适配
 * v1.2.0（UI）：去掉全部 emoji/符号图标（改用文字与 CSS 圆点），其余不变。
 *（prefers-color-scheme + html[data-color-mode="dark"]）、过滤区一行（搜索框 +
 * 类型分段选择器带数量）、日志改卡片式（method/状态码 pill、URL 独立行+复制
 * 按钮、请求/响应分块）、按钮整理成两排（敏感值改开关样式）、面板可收起成
 * 右下角带条数的小圆钮、空状态加图标提示。
 */

(function () {
    'use strict';

    // ===== 配置 =====
    const STORE_KEY = 'netdebug_logs_v1';
    const MAX_LOGS = 300;
    const BODY_LIMIT = 4000;
    const SENSITIVE = /authenticity_token|password|passwd|secret|_csrf|csrf|api[_-]?key|access[_-]?token|session|cookie/i;

    let recording = true;
    let showSensitive = false;
    let filterText = '';
    let filterType = 'all';
    let logs = [];

    // ===== 存储：GM 为主，localStorage 为备，刷新不清除 =====
    function loadLogs() {
        try {
            const raw = (typeof GM_getValue === 'function')
                ? GM_getValue(STORE_KEY, '')
                : localStorage.getItem(STORE_KEY) || '';
            if (!raw) return [];
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }
    function saveLogsSync() {
        try {
            const raw = JSON.stringify(logs);
            if (typeof GM_setValue === 'function') GM_setValue(STORE_KEY, raw);
            try { localStorage.setItem(STORE_KEY, raw); } catch (e) { /* localStorage 满了就只留 GM 那份 */ }
        } catch (e) { /* 存储失败也不影响页面 */ }
    }
    let saveTimer = null;
    function saveLogs() {
        if (saveTimer) return;
        saveTimer = setTimeout(() => { saveTimer = null; saveLogsSync(); }, 300);
    }

    // ===== 工具 =====
    const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');
    const trunc = (s) => {
        if (s == null) return '';
        s = String(s);
        return s.length > BODY_LIMIT ? s.slice(0, BODY_LIMIT) + '\n...[已截断，共 ' + s.length + ' 字]' : s;
    };
    function maskValue(key, val) {
        if (!showSensitive && SENSITIVE.test(String(key || ''))) {
            const v = String(val == null ? '' : val);
            if (v.length <= 8) return '***';
            return v.slice(0, 4) + '***' + v.slice(-4) + '（已打码，' + v.length + ' 位）';
        }
        return val;
    }
    function maskBodyText(text) {
        if (showSensitive || !text) return text;
        try {
            // URL 编码 / JSON 里的敏感字段值打码，字段名保留
            return String(text).replace(/((?:authenticity_token|password|secret|_csrf)[^=&"']*[=&"']\s*"?)([^&"'\s,}]+)/gi,
                (m, p1, p2) => p1 + (p2.length <= 8 ? '***' : p2.slice(0, 4) + '***' + p2.slice(-4)));
        } catch (e) { return text; }
    }
    function formDataToObj(fd) {
        const obj = {};
        try {
            fd.forEach((v, k) => { obj[k] = maskValue(k, v instanceof File ? '[File: ' + v.name + ']' : v); });
        } catch (e) { /* ignore */ }
        return obj;
    }
    async function bodyToText(body) {
        if (body == null) return '';
        try {
            if (typeof body === 'string') return body;
            if (body instanceof URLSearchParams) return body.toString();
            if (body instanceof FormData) return JSON.stringify(formDataToObj(body), null, 2);
            if (body instanceof Blob) return await body.text();
            if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
            return String(body);
        } catch (e) { return '[无法读取请求体: ' + e.message + ']'; }
    }
    function headersToObj(headers) {
        const obj = {};
        try {
            if (!headers) return obj;
            if (headers instanceof Headers) headers.forEach((v, k) => { obj[k] = v; });
            else if (typeof headers === 'object') Object.assign(obj, headers);
        } catch (e) { /* ignore */ }
        return obj;
    }

    function addLog(entry) {
        if (!recording) return;
        entry.id = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        entry.time = nowTime();
        entry.timestamp = Date.now();
        logs.unshift(entry);
        if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
        saveLogs();
        renderList();
    }

    // ===== 拦截 fetch（必须在 document-start 就包好） =====
    const origFetch = window.fetch;
    if (origFetch) {
        window.fetch = async function (input, init) {
            const start = performance.now();
            let url = '', method = 'GET', reqHeaders = {}, reqBody = '';
            try {
                if (typeof input === 'string') url = input;
                else if (input instanceof Request) { url = input.url; method = input.method || 'GET'; reqHeaders = headersToObj(input.headers); reqBody = await bodyToText(await input.clone().text().catch(() => '')); }
                if (init) {
                    if (init.method) method = init.method;
                    if (init.headers) reqHeaders = Object.assign(reqHeaders, headersToObj(init.headers));
                    if (init.body !== undefined) reqBody = await bodyToText(init.body);
                }
                if (!url && input && input.url) url = input.url;
            } catch (e) { /* 解析失败也继续发请求，记一笔就行 */ }
            try {
                const res = await origFetch.apply(this, arguments);
                const clone = res.clone();
                const resText = await clone.text().catch(() => '');
                addLog({
                    type: 'fetch', method: (method || 'GET').toUpperCase(), url: String(url),
                    reqHeaders, reqBody: trunc(maskBodyText(reqBody)),
                    status: res.status, statusText: res.statusText,
                    resHeaders: headersToObj(res.headers), resBody: trunc(resText),
                    durationMs: Math.round(performance.now() - start),
                });
                return res;
            } catch (err) {
                addLog({
                    type: 'fetch', method: (method || 'GET').toUpperCase(), url: String(url),
                    reqHeaders, reqBody: trunc(maskBodyText(reqBody)),
                    status: 0, statusText: 'FAILED: ' + (err && err.message ? err.message : err),
                    resHeaders: {}, resBody: '', durationMs: Math.round(performance.now() - start),
                });
                throw err;
            }
        };
    }

    // ===== 拦截 XHR =====
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this._nd = { method: method, url: String(url), start: 0, reqHeaders: {} };
        return origOpen.apply(this, arguments);
    };
    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        try { if (this._nd) this._nd.reqHeaders[k] = v; } catch (e) { /* ignore */ }
        return origSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
        const xhr = this;
        if (!xhr._nd) xhr._nd = { method: 'GET', url: '', start: 0, reqHeaders: {} };
        xhr._nd.start = performance.now();
        const reqBodyP = bodyToText(body);
        const done = () => {
            reqBodyP.then((reqBody) => {
                let resHeaders = {};
                try {
                    (xhr.getAllResponseHeaders() || '').split('\r\n').forEach((line) => {
                        const i = line.indexOf(':');
                        if (i > 0) resHeaders[line.slice(0, i).trim()] = line.slice(i + 1).trim();
                    });
                } catch (e) { /* ignore */ }
                addLog({
                    type: 'xhr', method: (xhr._nd.method || 'GET').toUpperCase(), url: xhr._nd.url,
                    reqHeaders: xhr._nd.reqHeaders, reqBody: trunc(maskBodyText(reqBody)),
                    status: xhr.status, statusText: xhr.statusText || '',
                    resHeaders, resBody: trunc(typeof xhr.responseText === 'string' ? xhr.responseText : ''),
                    durationMs: Math.round(performance.now() - xhr._nd.start),
                });
            });
        };
        xhr.addEventListener('load', done);
        xhr.addEventListener('error', done);
        return origSend.apply(this, arguments);
    };

    // ===== 拦截表单提交（删仓走的就是这个，整页跳转前必须记下来） =====
    function logForm(form, via) {
        if (!form || !recording) return;
        let bodyObj = {};
        try {
            const fd = new FormData(form);
            bodyObj = formDataToObj(fd);
        } catch (e) { /* ignore */ }
        addLog({
            type: 'form', method: (form.method || 'GET').toUpperCase(),
            url: form.action || location.href,
            reqHeaders: {}, reqBody: JSON.stringify(bodyObj, null, 2),
            status: 0, statusText: '表单提交（' + via + '），即将跳转，响应看下一页的日志',
            resHeaders: {}, resBody: '', durationMs: 0,
        });
        saveLogsSync(); // 跳转前立刻落盘，别等 300ms 防抖
    }
    document.addEventListener('submit', (e) => { logForm(e.target, 'submit 事件'); }, true);
    const origFormSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
        logForm(this, 'form.submit()');
        return origFormSubmit.apply(this, arguments);
    };
    // 跳转/刷新前把没落盘的日志写进去
    window.addEventListener('beforeunload', saveLogsSync);
    window.addEventListener('pagehide', saveLogsSync);

    // ===== 浮窗 UI（v1.1.0：只改 UI，下面的拦截/存储/打码逻辑原封不动） =====
    let panel = null, fab = null, listEl = null, countEl = null, segEl = null;
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    // v1.1.0：复用为 pill 背景色（白字），色值与 v1.0.0 相同
    function methodColor(m) {
        return { GET: '#0969da', POST: '#d1242f', DELETE: '#82071e', PUT: '#9a6700', PATCH: '#8250df' }[m] || '#656d76';
    }
    function statusColor(s) {
        if (!s) return '#656d76';
        if (s >= 200 && s < 300) return '#1a7f37';
        if (s >= 300 && s < 400) return '#9a6700';
        return '#d1242f';
    }
    function statusLabel(s) {
        if (!s) return '—';
        return String(s);
    }
    function curlFor(e) {
        const parts = ['curl -X ' + e.method + ' ' + JSON.stringify(e.url)];
        Object.entries(e.reqHeaders || {}).forEach(([k, v]) => parts.push('-H ' + JSON.stringify(k + ': ' + v)));
        if (e.reqBody) parts.push('--data ' + JSON.stringify(e.reqBody));
        return parts.join(' ');
    }
    function filteredLogs() {
        return logs.filter((e) => {
            if (filterType !== 'all' && e.type !== filterType) return false;
            if (!filterText) return true;
            const hay = (e.method + ' ' + e.url + ' ' + (e.reqBody || '') + ' ' + (e.resBody || '') + ' ' + e.status).toLowerCase();
            return hay.includes(filterText.toLowerCase());
        });
    }
    function renderList() {
        if (!listEl) return;
        const items = filteredLogs();
        // 标题徽章 + 收起圆钮上的条数
        if (countEl) countEl.textContent = String(logs.length);
        if (fab) fab.querySelector('.nd-fab-count').textContent = String(logs.length);
        // 类型分段选择器的数量
        if (segEl) {
            const counts = { all: logs.length, fetch: 0, xhr: 0, form: 0 };
            logs.forEach((e) => { if (counts[e.type] !== undefined) counts[e.type]++; });
            segEl.querySelectorAll('button[data-type]').forEach((b) => {
                b.classList.toggle('nd-seg-active', b.dataset.type === filterType);
                const n = counts[b.dataset.type] || 0;
                b.querySelector('.nd-seg-n').textContent = String(n);
            });
        }
        if (!items.length) {
            listEl.innerHTML = '<div class="nd-empty"><div class="nd-empty-icon"></div>'
                + '<div class="nd-empty-title">暂无日志</div>'
                + '<div class="nd-empty-sub">刷新也不会清，点「清空」才会删。<br>页面发出的 fetch / XHR / 表单提交会出现在这里。</div></div>';
            return;
        }
        listEl.innerHTML = items.slice(0, 100).map((e) => {
            const body = showSensitive ? e.reqBody : maskBodyText(e.reqBody || '');
            return '<details class="nd-card">'
                + '<summary class="nd-card-sum">'
                + '<span class="nd-meta-row">'
                + '<span class="nd-pill" style="background:' + methodColor(e.method) + '">' + esc(e.method) + '</span>'
                + '<span class="nd-pill" style="background:' + statusColor(e.status) + '">' + esc(statusLabel(e.status)) + '</span>'
                + '<span class="nd-meta">' + esc(e.time) + ' · ' + esc(e.type) + ' · ' + (e.durationMs || 0) + 'ms</span>'
                + '</span>'
                + '<span class="nd-url-row"><span class="nd-url">' + esc(e.url) + '</span>'
                + '<button type="button" class="nd-mini-btn" data-act="url" data-id="' + e.id + '" title="复制 URL">复制 URL</button></span>'
                + '</summary>'
                + '<div class="nd-actions"><button type="button" data-act="curl" data-id="' + e.id + '">复制 cURL</button> '
                + '<button type="button" data-act="copy" data-id="' + e.id + '">复制整条 JSON</button></div>'
                + '<div class="nd-sec"><div class="nd-sec-title">请求</div>'
                + '<pre class="nd-code">请求头：' + esc(JSON.stringify(e.reqHeaders || {}, null, 2))
                + '\n请求体：' + esc(body || '(空)') + '</pre></div>'
                + '<div class="nd-sec"><div class="nd-sec-title">响应' + (e.statusText ? ' · ' + esc(e.statusText) : '') + '</div>'
                + '<pre class="nd-code">响应头：' + esc(JSON.stringify(e.resHeaders || {}, null, 2))
                + '\n响应：' + esc(e.resBody || '(空)') + '</pre></div>'
                + '</details>';
        }).join('');
        listEl.querySelectorAll('button[data-act]').forEach((b) => {
            b.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const e = logs.find((x) => x.id === b.dataset.id);
                if (!e) return;
                const label = b.textContent;
                const text = b.dataset.act === 'curl' ? curlFor(e)
                    : b.dataset.act === 'url' ? e.url
                    : JSON.stringify(e, null, 2);
                navigator.clipboard.writeText(text).then(() => {
                    b.textContent = '已复制';
                    setTimeout(() => { b.textContent = label; }, 1200);
                });
            });
        });
    }
    function exportJSON() {
        const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        a.href = URL.createObjectURL(blob);
        a.download = 'netdebug-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    function injectPanel() {
        if (panel || !document.body) return;
        logs = loadLogs();
        const style = document.createElement('style');
        style.textContent = ''
            + '#nd-panel{--nd-bg:#ffffff;--nd-bg2:#f6f8fa;--nd-border:#d0d7de;--nd-text:#1f2328;--nd-muted:#656d76;--nd-code:#f6f8fa;--nd-accent:#0969da;--nd-danger:#d1242f;--nd-shadow:0 12px 32px rgba(31,35,40,.16),0 2px 8px rgba(31,35,40,.08);'
            + 'position:fixed;right:12px;bottom:12px;z-index:2147483647;width:440px;max-width:94vw;background:var(--nd-bg);border:1px solid var(--nd-border);border-radius:12px;box-shadow:var(--nd-shadow);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--nd-text)}'
            + '@media (prefers-color-scheme:dark){#nd-panel{--nd-bg:#0d1117;--nd-bg2:#161b22;--nd-border:#30363d;--nd-text:#e6edf3;--nd-muted:#8b949e;--nd-code:#0d1117;--nd-shadow:0 12px 32px rgba(0,0,0,.5)}}'
            + 'html[data-color-mode="dark"] #nd-panel{--nd-bg:#0d1117;--nd-bg2:#161b22;--nd-border:#30363d;--nd-text:#e6edf3;--nd-muted:#8b949e;--nd-code:#0d1117;--nd-shadow:0 12px 32px rgba(0,0,0,.5)}'
            + '#nd-panel .nd-head{cursor:move;padding:10px 12px;border-bottom:1px solid var(--nd-border);font-weight:700;display:flex;gap:8px;align-items:center}'
            + '#nd-panel .nd-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#1a7f37;flex:none}'
            + '#nd-panel .nd-dot.rec{animation:nd-pulse 2s ease-in-out infinite}'
            + '#nd-panel .nd-dot.paused{background:#9a6700;animation:none}'
            + '@keyframes nd-pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(26,127,55,.45)}50%{opacity:.65;box-shadow:0 0 0 5px rgba(26,127,55,0)}}'
            + '#nd-panel .nd-title{flex:1;font-size:14px}'
            + '#nd-panel .nd-badge{display:inline-block;min-width:22px;text-align:center;padding:1px 7px;border-radius:999px;background:var(--nd-accent);color:#fff;font-size:11px;font-weight:700}'
            + '#nd-panel .nd-icon-btn{cursor:pointer;border:1px solid var(--nd-border);background:var(--nd-bg2);color:var(--nd-text);border-radius:6px;width:24px;height:24px;line-height:1;padding:0}'
            + '#nd-panel .nd-body{padding:10px 12px;max-height:56vh;overflow:auto}'
            + '#nd-panel .nd-filter-row{display:flex;gap:8px;align-items:stretch;margin-bottom:8px}'
            + '#nd-panel .nd-search{flex:1;display:flex;align-items:center;gap:6px;border:1px solid var(--nd-border);border-radius:8px;padding:0 8px;background:var(--nd-bg)}'
            + '#nd-panel .nd-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--nd-text);padding:6px 0;font:inherit}'
            + '#nd-panel .nd-seg{display:flex;border:1px solid var(--nd-border);border-radius:8px;overflow:hidden;flex:none}'
            + '#nd-panel .nd-seg button{cursor:pointer;border:0;border-right:1px solid var(--nd-border);background:var(--nd-bg);color:var(--nd-text);padding:5px 8px;font-size:12px}'
            + '#nd-panel .nd-seg button:last-child{border-right:0}'
            + '#nd-panel .nd-seg button.nd-seg-active{background:var(--nd-accent);color:#fff}'
            + '#nd-panel .nd-seg-n{opacity:.75;font-size:11px;margin-left:2px}'
            + '#nd-panel .nd-btn-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}'
            + '#nd-panel .nd-btn-row button{cursor:pointer;padding:5px 10px;border-radius:6px;border:1px solid var(--nd-border);background:var(--nd-bg2);color:var(--nd-text);font-size:12px}'
            + '#nd-panel .nd-btn-row button.nd-danger{color:var(--nd-danger);border-color:var(--nd-danger);background:transparent}'
            + '#nd-panel .nd-switch{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;padding:5px 10px;border:1px solid var(--nd-border);border-radius:6px;background:var(--nd-bg2)}'
            + '#nd-panel .nd-switch input{display:none}'
            + '#nd-panel .nd-slider{width:30px;height:17px;border-radius:999px;background:#8b949e;position:relative;flex:none;transition:background .2s}'
            + '#nd-panel .nd-slider::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:left .2s}'
            + '#nd-panel .nd-switch input:checked + .nd-slider{background:#1a7f37}'
            + '#nd-panel .nd-switch input:checked + .nd-slider::after{left:15px}'
            + '#nd-panel .nd-card{border:1px solid var(--nd-border);border-radius:10px;padding:8px 10px;margin-bottom:8px;background:var(--nd-bg)}'
            + '#nd-panel .nd-card-sum{cursor:pointer;list-style:none}'
            + '#nd-panel .nd-card-sum::-webkit-details-marker{display:none}'
            + '#nd-panel .nd-meta-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}'
            + '#nd-panel .nd-pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:700;color:#fff}'
            + '#nd-panel .nd-meta{color:var(--nd-muted);font-size:12px}'
            + '#nd-panel .nd-url-row{display:flex;gap:6px;align-items:flex-start;margin-top:4px}'
            + '#nd-panel .nd-url{flex:1;min-width:0;word-break:break-all;font-size:12px}'
            + '#nd-panel .nd-mini-btn{cursor:pointer;flex:none;padding:1px 7px;border-radius:6px;border:1px solid var(--nd-border);background:var(--nd-bg2);color:var(--nd-text);font-size:11px}'
            + '#nd-panel .nd-actions{display:flex;gap:6px;margin:8px 0 0}'
            + '#nd-panel .nd-actions button{cursor:pointer;padding:3px 8px;border-radius:6px;border:1px solid var(--nd-border);background:var(--nd-bg2);color:var(--nd-text);font-size:12px}'
            + '#nd-panel .nd-sec{margin-top:8px}'
            + '#nd-panel .nd-sec-title{font-size:12px;font-weight:700;color:var(--nd-muted);margin-bottom:4px}'
            + '#nd-panel .nd-code{white-space:pre-wrap;word-break:break-all;background:var(--nd-code);border:1px solid var(--nd-border);padding:8px;border-radius:8px;margin:0;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--nd-text)}'
            + '#nd-panel .nd-empty{text-align:center;padding:28px 12px;color:var(--nd-muted)}'
            + '#nd-panel .nd-empty-icon{font-size:32px;line-height:1;margin-bottom:8px}'
            + '#nd-panel .nd-empty-title{font-size:14px;font-weight:700;color:var(--nd-text);margin-bottom:4px}'
            + '#nd-panel .nd-empty-sub{font-size:12px}'
            + '#nd-fab{position:fixed;right:12px;bottom:12px;z-index:2147483647;width:52px;height:52px;border-radius:50%;border:0;background:#0969da;color:#fff;font-size:20px;cursor:pointer;box-shadow:0 8px 20px rgba(9,105,218,.4);display:none;align-items:center;justify-content:center}'
            + '#nd-fab .nd-fab-count{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:#d1242f;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}';
        document.head.appendChild(style);

        panel = document.createElement('div');
        panel.id = 'nd-panel';
        panel.innerHTML = '<div class="nd-head"><span class="nd-dot rec" id="nd-dot"></span><span id="nd-state">录制中</span><span class="nd-title">NetDebug</span><span class="nd-badge" id="nd-count">0</span><button type="button" class="nd-icon-btn" id="nd-toggle-body" title="收起成小圆钮">—</button></div>'
            + '<div class="nd-body" id="nd-body">'
            + '<div class="nd-filter-row">'
            + '<label class="nd-search"><span>搜索</span><input id="nd-filter" placeholder="过滤：搜 delete / settings / 关键词"></label>'
            + '<div class="nd-seg" id="nd-type">'
            + '<button type="button" data-type="all">全部<span class="nd-seg-n">0</span></button>'
            + '<button type="button" data-type="fetch">fetch<span class="nd-seg-n">0</span></button>'
            + '<button type="button" data-type="xhr">xhr<span class="nd-seg-n">0</span></button>'
            + '<button type="button" data-type="form">form<span class="nd-seg-n">0</span></button>'
            + '</div></div>'
            + '<div class="nd-btn-row">'
            + '<button type="button" id="nd-pause">暂停</button><button type="button" id="nd-export">导出 JSON</button>'
            + '</div>'
            + '<div class="nd-btn-row">'
            + '<label class="nd-switch"><input type="checkbox" id="nd-sensitive"><span class="nd-slider"></span>显示敏感值</label>'
            + '<button type="button" class="nd-danger" id="nd-clear">清空</button>'
            + '</div>'
            + '<div id="nd-list"></div></div>';
        document.body.appendChild(panel);

        // 收起后的小圆钮：显示总条数，点一下再展开
        fab = document.createElement('button');
        fab.type = 'button';
        fab.id = 'nd-fab';
        fab.title = '展开 NetDebug';
        fab.innerHTML = '日志<span class="nd-fab-count">0</span>';
        document.body.appendChild(fab);
        fab.addEventListener('click', () => {
            panel.style.display = '';
            fab.style.display = 'none';
        });

        listEl = panel.querySelector('#nd-list');
        countEl = panel.querySelector('#nd-count');
        segEl = panel.querySelector('#nd-type');

        panel.querySelector('#nd-filter').addEventListener('input', (e) => { filterText = e.target.value; renderList(); });
        segEl.querySelectorAll('button[data-type]').forEach((b) => {
            b.addEventListener('click', () => { filterType = b.dataset.type; renderList(); });
        });
        panel.querySelector('#nd-pause').addEventListener('click', (e) => {
            recording = !recording;
            e.target.textContent = recording ? '暂停' : '继续';
            panel.querySelector('#nd-state').textContent = recording ? '录制中' : '已暂停';
            const dot = panel.querySelector('#nd-dot');
            dot.classList.toggle('rec', recording);
            dot.classList.toggle('paused', !recording);
        });
        panel.querySelector('#nd-export').addEventListener('click', exportJSON);
        panel.querySelector('#nd-sensitive').addEventListener('change', (e) => {
            showSensitive = e.target.checked;
            renderList();
        });
        panel.querySelector('#nd-clear').addEventListener('click', () => {
            if (!confirm('确定清空全部 ' + logs.length + ' 条日志吗？清空后刷新也找不回来。')) return;
            logs = [];
            saveLogsSync();
            try { if (typeof GM_deleteValue === 'function') GM_deleteValue(STORE_KEY); localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
            renderList();
        });
        panel.querySelector('#nd-toggle-body').addEventListener('click', () => {
            panel.style.display = 'none';
            fab.style.display = 'flex';
            fab.querySelector('.nd-fab-count').textContent = String(logs.length);
        });
        // 拖动标题栏移动浮窗
        const head = panel.querySelector('.nd-head');
        head.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            const sx = e.clientX - panel.getBoundingClientRect().left, sy = e.clientY - panel.getBoundingClientRect().top;
            const move = (ev) => { panel.style.right = 'auto'; panel.style.bottom = 'auto'; panel.style.left = (ev.clientX - sx) + 'px'; panel.style.top = (ev.clientY - sy) + 'px'; };
            const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });
        renderList();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectPanel);
    } else {
        injectPanel();
    }
    // document-start 时 body 还没好，兜底再试一次
    setTimeout(injectPanel, 1500);
})();
