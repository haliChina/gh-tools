// ==UserScript==
// @name         GitHub 仓库快速删除
// @namespace    https://github.com/haliChina
// @version      2.3.0
// @description  在仓库列表页勾选多个仓库批量删除。优先直接 POST 删除接口（已实测），失败时自动回落到 Settings 三步 UI 点击。不猜 token，每次都从 Settings 页现取。
// @author       haliChina
// @match        https://github.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/*
 * 实测依据（2026-11-07，用 Network Debug 脚本抓到的真删记录）：
 * - 12:21:28.933，一条 type=form 的记录，就是删 haliChina/test2 的那次：
 *   POST https://github.com/haliChina/test2/settings/delete
 *   请求体（表单字段，authenticity_token 的值已打码，只确认字段名）：
 *     _method = delete
 *     authenticity_token = <86 位，每次从 Settings 页现取，一次性>
 *     verification_field = haliChina/test2
 *     verify = haliChina/test2
 * - 删完跳回 https://github.com/haliChina?tab=repositories，随后 12:21:32-36
 *   仓库列表页正常加载；test2 再访问已是 404，确认删成功了。
 * - 其余 41 条全是噪音：7 条 Datadog RUM 上报（请求体是 deflate 压缩的二进制，
 *   看不懂也不用管），34 条是仓库列表页的 participation 迷你图 GET。
 *
 * 所以 v2 改成直接 POST，流程：
 *   GET https://github.com/<owner>/<repo>/settings → 从里面的删除表单现取
 *   authenticity_token → POST 上面那个地址，带上面 4 个字段 → 再 GET 仓库页，
 *   返回 404 即确认删成功。token 不缓存、不硬编码，每次现取现用。
 *   取不到 token 或 POST 失败时，自动回落到 v1 的 UI 方式：
 *   打开 Settings 页自动点三步确认（按钮文字见下面 autoDeleteCurrent）。
 *
 * v2.1.0（UI）：浮窗改 Primer 风格 + 深色适配 + 已选 chips + 进度条/状态行 + 自定义确认弹窗；删除逻辑未动。
 * v2.2.0（UI）：去掉全部 emoji/符号图标（改用文字、CSS 圆点与 SVG）。
 * v2.3.0（检测）：只在自己的仓库列表页触发——路径必须是 /haliChina 且 tab=repositories，标题含 Repositories 或页头显示 Your Repositories 才认（手机端顶栏就是这个标题）；别人的仓库页不再出现浮窗与复选框；Settings 页回落也只认 /haliChina/<仓库>/settings。窄屏浮窗默认收起。
 *
 * 用法：
 * 1. Tampermonkey 安装本脚本，打开 https://github.com/haliChina?tab=repositories
 * 2. 每行仓库后面会出现复选框和删除按钮，勾选要删的，点右下角浮窗“删除选中”
 *    或直接点某一行的删除按钮只删那一个
 * 3. 确认框逐个列出全名，确认后脚本在列表页直接发 POST 逐个删，删完一个
 *    在浮窗里打勾，全部跑完出汇总；失败的会列出来，点“用 UI 方式补删”
 *    会逐个打开 Settings 页自动走完三步
 *
 * 安全：
 * - 受保护仓库写在下面的 PROTECTED 里，勾选/删除时会被直接跳过
 * - 批量开始前必须在确认框里再点一次确认，脚本不会一打开页面就自动删
 * - 删除不可逆，GitHub 没有回收站，确认框列出的名字请逐个核对
 */

(function () {
    'use strict';

    // ===== 可改配置：永远不删的仓库，只写仓库名，不写 owner =====
    // 例：const PROTECTED = ['SecAgent', 'SecAgent-ComputerUse', 'naiwa-hub'];
    const PROTECTED = [];

    const QUEUE_KEY = 'gh_del_queue_v1'; // UI 回落模式用的队列
    const OWNER = 'haliChina';

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function getQueue() {
        try { return JSON.parse(GM_getValue(QUEUE_KEY, '[]') || '[]'); } catch (e) { return []; }
    }
    function setQueue(q) { GM_setValue(QUEUE_KEY, JSON.stringify(q)); }
    function clearQueue() { GM_deleteValue(QUEUE_KEY); }

    function isProtected(fullName) {
        const name = fullName.split('/')[1] || fullName;
        return PROTECTED.includes(name);
    }

    // ================= 直接 POST 删除（v2 主路径） =================
    async function fetchDeleteToken(fullName) {
        const res = await fetch('https://github.com/' + fullName + '/settings', {
            credentials: 'include',
            headers: { Accept: 'text/html' },
        });
        if (!res.ok) throw new Error('打开 Settings 页失败，HTTP ' + res.status);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        // 删除表单的 action 就是 /<owner>/<repo>/settings/delete
        const form = doc.querySelector('form[action$="/settings/delete"]')
            || doc.querySelector('form[action*="/settings/delete"]');
        const input = form
            ? form.querySelector('input[name="authenticity_token"]')
            : doc.querySelector('input[name="authenticity_token"]');
        const token = input ? input.value : '';
        if (!token) throw new Error('在 Settings 页没找到删除表单的 authenticity_token');
        return token;
    }

    async function deleteViaPost(fullName) {
        const token = await fetchDeleteToken(fullName);
        const body = new URLSearchParams();
        body.set('_method', 'delete');
        body.set('authenticity_token', token);
        body.set('verification_field', fullName);
        body.set('verify', fullName);
        const res = await fetch('https://github.com/' + fullName + '/settings/delete', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
        // GitHub 删完会 302 跳回仓库列表页，fetch 跟随跳转后一般是 200；
        // 最可靠的确认是再 GET 一次仓库页，看是不是 404
        await sleep(500);
        const check = await fetch('https://github.com/' + fullName, {
            credentials: 'include', redirect: 'manual',
        }).catch(() => null);
        const gone = check && (check.status === 404 || check.type === 'opaqueredirect');
        if (!gone && !res.ok) throw new Error('删除请求返回 HTTP ' + res.status);
        if (!gone) throw new Error('删完复查：仓库页不是 404，没确认删成功');
        return true;
    }

    // ================= UI：Primer 风格共享样式（浮窗 / 弹窗 / 回落进度条共用） =================
    // 只改样式，不碰任何删除逻辑。深色同时看 GitHub 自身的 data-color-mode 和系统偏好。
    function ensureGhDelStyles() {
        if (document.getElementById('gh-del-style')) return;
        const style = document.createElement('style');
        style.id = 'gh-del-style';
        style.textContent = `
            #gh-del-panel, #gh-del-modal-overlay, #gh-del-bar {
                --gh-bg: #ffffff; --gh-bg-subtle: #f6f8fa; --gh-bg-danger-subtle: #ffebe9;
                --gh-border: #d0d7de; --gh-text: #1f2328; --gh-text-muted: #656d76;
                --gh-danger: #d1242f; --gh-danger-hover: #a40e26;
                --gh-success: #1a7f37; --gh-success-bg: #dafbe1;
                --gh-shadow: 0 8px 24px rgba(140, 149, 159, 0.2);
            }
            html[data-color-mode="dark"] #gh-del-panel, html[data-color-mode="dark"] #gh-del-modal-overlay, html[data-color-mode="dark"] #gh-del-bar {
                --gh-bg: #0d1117; --gh-bg-subtle: #161b22; --gh-bg-danger-subtle: #3d1215;
                --gh-border: #30363d; --gh-text: #e6edf3; --gh-text-muted: #8b949e;
                --gh-danger: #f85149; --gh-danger-hover: #ff7b72;
                --gh-success: #3fb950; --gh-success-bg: #12261a;
                --gh-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
            }
            @media (prefers-color-scheme: dark) {
                #gh-del-panel, #gh-del-modal-overlay, #gh-del-bar {
                    --gh-bg: #0d1117; --gh-bg-subtle: #161b22; --gh-bg-danger-subtle: #3d1215;
                    --gh-border: #30363d; --gh-text: #e6edf3; --gh-text-muted: #8b949e;
                    --gh-danger: #f85149; --gh-danger-hover: #ff7b72;
                    --gh-success: #3fb950; --gh-success-bg: #12261a;
                    --gh-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
                }
            }
            /* 每行仓库后的幽灵删除按钮：平时低调，hover 才变红 */
            .gh-del-check { accent-color: #d1242f; width: 16px; height: 16px; cursor: pointer; margin-right: 6px; vertical-align: middle; flex: none; }
            .gh-del-btn { cursor: pointer; background: transparent; border: 1px solid transparent; color: var(--gh-text-muted, #656d76); border-radius: 6px; padding: 2px 8px; font-size: 12px; margin-left: 8px; line-height: 1.5; }
            .gh-del-btn:hover { background: #d1242f; border-color: #d1242f; color: #fff; }
            /* 浮窗 */
            #gh-del-panel { position: fixed; right: 16px; bottom: 16px; z-index: 9999; width: 380px; max-width: calc(100vw - 32px); background: var(--gh-bg); color: var(--gh-text); border: 1px solid var(--gh-border); border-radius: 12px; box-shadow: var(--gh-shadow); padding: 14px 16px; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            #gh-del-panel .gh-del-head { display: flex; align-items: center; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid var(--gh-border); margin-bottom: 10px; font-size: 14px; font-weight: 600; }
            #gh-del-panel .gh-del-badge { background: var(--gh-danger); color: #fff; border-radius: 999px; padding: 0 8px; font-size: 12px; font-weight: 600; line-height: 20px; min-width: 20px; text-align: center; }
            #gh-del-panel .gh-del-ver { margin-left: auto; font-size: 11px; font-weight: 400; color: var(--gh-text-muted); }
            #gh-del-panel .gh-del-toggle { cursor: pointer; background: transparent; border: 1px solid var(--gh-border); color: var(--gh-text-muted); border-radius: 6px; padding: 0 8px; font-size: 12px; line-height: 20px; }
            #gh-del-panel.gh-del-collapsed > :not(.gh-del-head) { display: none; }
            #gh-del-panel.gh-del-collapsed .gh-del-head { padding-bottom: 0; border-bottom: none; margin-bottom: 0; }
            @media (max-width: 640px) { #gh-del-panel { right: 8px; bottom: 8px; width: calc(100vw - 16px); } }
            #gh-del-panel .gh-del-sub { color: var(--gh-text-muted); font-size: 12px; margin-bottom: 8px; }
            #gh-del-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
            #gh-del-chips:empty { display: none; }
            .gh-del-chip { display: inline-flex; align-items: center; gap: 4px; background: var(--gh-bg-subtle); border: 1px solid var(--gh-border); border-radius: 999px; padding: 2px 4px 2px 8px; font-size: 12px; color: var(--gh-text); max-width: 100%; }
            .gh-del-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .gh-del-chip button { cursor: pointer; border: none; background: transparent; color: var(--gh-text-muted); border-radius: 50%; width: 16px; height: 16px; line-height: 14px; font-size: 12px; padding: 0; flex: none; }
            .gh-del-chip button:hover { background: var(--gh-danger); color: #fff; }
            #gh-del-panel .gh-del-actions { display: flex; gap: 8px; flex-wrap: wrap; }
            #gh-del-panel .gh-del-actions button { cursor: pointer; padding: 5px 12px; border-radius: 6px; font-size: 13px; font-weight: 500; line-height: 20px; }
            .gh-del-btn-primary { background: var(--gh-danger); color: #fff; border: 1px solid var(--gh-danger); }
            .gh-del-btn-primary:hover { background: var(--gh-danger-hover); border-color: var(--gh-danger-hover); }
            .gh-del-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
            .gh-del-btn-secondary { background: transparent; color: var(--gh-text); border: 1px solid var(--gh-border); }
            .gh-del-btn-secondary:hover { background: var(--gh-bg-subtle); }
            /* 进度条 + 逐条状态 */
            #gh-del-progress-wrap { margin-top: 12px; border-top: 1px solid var(--gh-border); padding-top: 10px; }
            #gh-del-progress-wrap[hidden] { display: none; }
            .gh-del-progress { height: 8px; background: var(--gh-bg-subtle); border: 1px solid var(--gh-border); border-radius: 999px; overflow: hidden; }
            .gh-del-progress > div { height: 100%; width: 0%; background: var(--gh-danger); transition: width 0.3s ease; }
            #gh-del-progress-text { font-size: 12px; color: var(--gh-text-muted); margin: 6px 0 2px; }
            .gh-del-status-row { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-top: 1px solid var(--gh-border); font-size: 12px; word-break: break-all; }
            .gh-del-status-row:first-child { border-top: none; }
            .gh-del-status-ico { flex: none; width: 12px; height: 12px; border-radius: 50%; margin-top: 3px; }
            .gh-del-status-ok { background: var(--gh-success); }
            .gh-del-status-fail { background: var(--gh-danger); }
            .gh-del-status-run { background: transparent; border: 2px solid var(--gh-border); border-top-color: var(--gh-danger); }
            .gh-del-spin { display: inline-block; animation: gh-del-spin 1s linear infinite; }
            @keyframes gh-del-spin { to { transform: rotate(360deg); } }
            .gh-del-status-reason { color: var(--gh-text-muted); }
            /* 自定义确认弹窗 */
            #gh-del-modal-overlay { position: fixed; inset: 0; z-index: 10000; background: rgba(31, 35, 40, 0.6); display: flex; align-items: center; justify-content: center; padding: 16px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            .gh-del-modal { width: 440px; max-width: 100%; max-height: 84vh; overflow: auto; background: var(--gh-bg); color: var(--gh-text); border: 1px solid var(--gh-border); border-radius: 12px; box-shadow: var(--gh-shadow); padding: 16px; }
            .gh-del-modal h3 { margin: 0 0 8px; font-size: 16px; }
            .gh-del-modal p { margin: 0 0 8px; color: var(--gh-text-muted); font-size: 13px; }
            .gh-del-modal ul { margin: 0 0 12px; padding: 8px 8px 8px 24px; background: var(--gh-bg-subtle); border: 1px solid var(--gh-border); border-radius: 8px; font-size: 13px; max-height: 220px; overflow: auto; word-break: break-all; }
            .gh-del-modal .gh-del-warn { background: var(--gh-bg-danger-subtle); border: 1px solid var(--gh-danger); color: var(--gh-danger); border-radius: 8px; padding: 8px 12px; font-size: 13px; font-weight: 600; margin-bottom: 14px; }
            .gh-del-modal .gh-del-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
            .gh-del-modal .gh-del-modal-actions button { cursor: pointer; padding: 5px 12px; border-radius: 6px; font-size: 13px; font-weight: 500; line-height: 20px; }
            /* Settings 页回落进度条 */
            #gh-del-bar { position: sticky; top: 0; z-index: 9999; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: var(--gh-bg); color: var(--gh-text); border: 1px solid var(--gh-border); border-left: 4px solid var(--gh-danger); border-radius: 12px; box-shadow: var(--gh-shadow); padding: 12px 14px; margin: 12px 0; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            #gh-del-bar b { color: var(--gh-danger); }
            #gh-del-bar button { cursor: pointer; margin-left: auto; padding: 5px 12px; border-radius: 6px; font-size: 13px; background: transparent; color: var(--gh-text); border: 1px solid var(--gh-border); }
            #gh-del-bar button:hover { background: var(--gh-bg-subtle); }
        `;
        document.head.appendChild(style);
    }

    // 自定义确认弹窗（替代原生 confirm）：遮罩 + 卡片，返回 Promise<boolean>
    function showGhConfirm(opts) {
        ensureGhDelStyles();
        return new Promise((resolve) => {
            document.getElementById('gh-del-modal-overlay')?.remove();
            const overlay = document.createElement('div');
            overlay.id = 'gh-del-modal-overlay';
            const namesHtml = (opts.names && opts.names.length)
                ? '<ul>' + opts.names.map((n) => '<li>' + n.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</li>').join('') + '</ul>'
                : '';
            overlay.innerHTML = '<div class="gh-del-modal" role="dialog" aria-modal="true">'
                + '<h3>' + (opts.title || '确认删除') + '</h3>'
                + (opts.intro ? '<p>' + opts.intro + '</p>' : '')
                + namesHtml
                + '<div class="gh-del-warn">注意：删除不可逆，GitHub 没有回收站</div>'
                + '<div class="gh-del-modal-actions">'
                + '<button type="button" class="gh-del-btn-secondary" data-act="cancel">' + (opts.cancelText || '取消') + '</button>'
                + '<button type="button" class="gh-del-btn-primary" data-act="confirm">' + (opts.confirmText || '确认删除') + '</button>'
                + '</div></div>';
            const done = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
            const onKey = (e) => { if (e.key === 'Escape') done(false); };
            overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
            overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => done(false));
            overlay.querySelector('[data-act="confirm"]').addEventListener('click', () => done(true));
            document.addEventListener('keydown', onKey, true);
            document.body.appendChild(overlay);
            overlay.querySelector('[data-act="confirm"]').focus();
        });
    }

    // ================= 仓库列表页 =================
    function isRepoListPage() {
        // 只在自己的仓库列表页触发：路径必须是 /haliChina，tab=repositories。
        // 之前没加 owner 判断，别人的仓库页也会触发浮窗。
        const m = location.pathname.match(/^\/([^/]+)\/?$/);
        if (!m || m[1].toLowerCase() !== OWNER.toLowerCase()) return false;
        if (!/tab=repositories/.test(location.search)) return false;
        if (document.querySelector('#user-repositories-list, [data-testid="user-repositories-list"]')) return true;
        if (/Repositories/.test(document.title)) return true;
        // 手机端：自己的页面顶栏标题是 Your Repositories，别人的不是
        return Array.from(document.querySelectorAll('h1, h2, header, nav')).some((el) => /Your Repositories/.test(el.textContent || ''));
    }

    function getRepoLinks() {
        let links = Array.from(document.querySelectorAll('a[itemprop="name codeRepository"]'));
        if (!links.length) links = Array.from(document.querySelectorAll('#user-repositories-list h3 a'));
        if (!links.length) {
            links = Array.from(document.querySelectorAll('#user-repositories-list a[href^="/' + OWNER + '/"]'))
                .filter((a) => /^\/[^/]+\/[^/]+\/?$/.test(a.getAttribute('href') || ''));
        }
        // 纵深防御：只留自己名下的仓库链接，别人的仓库就算被扫到也不挂复选框
        links = links.filter((a) => new RegExp('^/' + OWNER + '/[^/]+/?$').test(a.getAttribute('href') || ''));
        return links;
    }

    function repoFullNameFromLink(a) {
        const href = (a.getAttribute('href') || '').replace(/\/$/, '');
        const parts = href.split('/').filter(Boolean);
        if (parts.length === 2) return parts.join('/');
        return OWNER + '/' + (a.textContent || '').trim();
    }

    function injectListUI() {
        if (document.getElementById('gh-del-panel')) return;
        ensureGhDelStyles();

        const selected = new Set();
        const checkByName = new Map();

        const panel = document.createElement('div');
        panel.id = 'gh-del-panel';
        panel.innerHTML = '<div class="gh-del-head"><span aria-hidden="true"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M6 1.5a.5.5 0 0 0-.5.5v1h-3a.5.5 0 0 0 0 1h1v9.5A1.5 1.5 0 0 0 5 15h6a1.5 1.5 0 0 0 1.5-1.5V4h1a.5.5 0 0 0 0-1h-3v-1a.5.5 0 0 0-.5-.5h-4zM6 3h4v1H6V3zm1 3.5a.5.5 0 0 1 1 0v4a.5.5 0 0 1-1 0v-4zm3 0a.5.5 0 0 1 1 0v4a.5.5 0 0 1-1 0v-4z"/></svg></span><span>仓库清理</span>'
            + '<span class="gh-del-badge" id="gh-del-count">0</span>'
            + '<span class="gh-del-ver">v2.3.0 · 直接 POST</span><button type="button" class="gh-del-toggle" id="gh-del-toggle">收起</button></div>'
            + '<div class="gh-del-sub">勾选要删的仓库，脚本在列表页直接发请求逐个删，失败的自动记下来用 UI 方式补删。</div>'
            + '<div id="gh-del-chips"></div>'
            + '<div class="gh-del-actions">'
            + '<button type="button" class="gh-del-btn-primary" id="gh-del-go">删除选中</button>'
            + '<button type="button" class="gh-del-btn-secondary" id="gh-del-select-all">全选本页</button>'
            + '<button type="button" class="gh-del-btn-secondary" id="gh-del-clear">清空选择</button>'
            + '</div>'
            + '<div id="gh-del-progress-wrap" hidden>'
            + '<div class="gh-del-progress"><div id="gh-del-progress-bar"></div></div>'
            + '<div id="gh-del-progress-text"></div>'
            + '<div id="gh-del-status"></div>'
            + '</div>';
        document.body.appendChild(panel);

        const toggleBtn = panel.querySelector('#gh-del-toggle');
        toggleBtn.addEventListener('click', () => {
            const collapsed = panel.classList.toggle('gh-del-collapsed');
            toggleBtn.textContent = collapsed ? '展开' : '收起';
        });
        // 窄屏（手机）默认收起，只留标题栏，不挡下面的搜索框
        if (window.innerWidth <= 640) {
            panel.classList.add('gh-del-collapsed');
            toggleBtn.textContent = '展开';
        }

        const chipsEl = panel.querySelector('#gh-del-chips');
        const countEl = panel.querySelector('#gh-del-count');
        const progressWrap = panel.querySelector('#gh-del-progress-wrap');
        const progressBar = panel.querySelector('#gh-del-progress-bar');
        const progressText = panel.querySelector('#gh-del-progress-text');
        const statusEl = panel.querySelector('#gh-del-status');
        const goBtn = panel.querySelector('#gh-del-go');

        // 进度 UI：进度条 + 逐条状态行（进行中转圈 / 成功 / 失败带原因），状态用文字与 CSS 圆点表示
        const progress = {
            total: 0, done: 0, rows: new Map(),
            init(names) {
                this.total = names.length; this.done = 0; this.rows = new Map();
                progressWrap.hidden = false;
                progressBar.style.width = '0%';
                progressText.textContent = '准备删除 0 / ' + names.length;
                statusEl.innerHTML = '';
                names.forEach((n) => {
                    const row = document.createElement('div');
                    row.className = 'gh-del-status-row';
                    row.innerHTML = '<span class="gh-del-status-ico gh-del-status-run gh-del-spin"></span><span></span>';
                    row.lastChild.textContent = n;
                    statusEl.appendChild(row);
                    this.rows.set(n, row);
                });
            },
            set(name, state, reason) {
                const row = this.rows.get(name);
                if (!row) return;
                const ico = row.querySelector('.gh-del-status-ico');
                if (state === 'run') { ico.textContent = ''; ico.className = 'gh-del-status-ico gh-del-status-run gh-del-spin'; }
                if (state === 'ok') { ico.textContent = ''; ico.className = 'gh-del-status-ico gh-del-status-ok'; this.done += 1; }
                if (state === 'fail') {
                    ico.textContent = ''; ico.className = 'gh-del-status-ico gh-del-status-fail'; this.done += 1;
                    const r = document.createElement('div');
                    r.className = 'gh-del-status-reason';
                    r.textContent = reason || '';
                    row.appendChild(r);
                }
                progressBar.style.width = Math.round((this.done / Math.max(this.total, 1)) * 100) + '%';
                progressText.textContent = '已完成 ' + this.done + ' / ' + this.total;
            },
        };

        const renderChips = () => {
            countEl.textContent = String(selected.size);
            chipsEl.innerHTML = '';
            Array.from(selected).forEach((fullName) => {
                const chip = document.createElement('span');
                chip.className = 'gh-del-chip';
                const label = document.createElement('span');
                label.textContent = fullName;
                const x = document.createElement('button');
                x.type = 'button';
                x.textContent = '×';
                x.title = '取消勾选 ' + fullName;
                x.setAttribute('aria-label', '取消勾选 ' + fullName);
                x.addEventListener('click', () => {
                    selected.delete(fullName);
                    const c = checkByName.get(fullName);
                    if (c) c.checked = false;
                    renderChips();
                });
                chip.appendChild(label);
                chip.appendChild(x);
                chipsEl.appendChild(chip);
            });
            goBtn.disabled = selected.size === 0;
        };

        getRepoLinks().forEach((a) => {
            const fullName = repoFullNameFromLink(a);
            const row = a.closest('li') || a.parentElement;
            if (!row || row.querySelector('.gh-del-check')) return;

            const check = document.createElement('input');
            check.type = 'checkbox';
            check.className = 'gh-del-check';
            check.title = '勾选以批量删除 ' + fullName;
            check.addEventListener('change', () => {
                if (check.checked) selected.add(fullName);
                else selected.delete(fullName);
                renderChips();
            });
            checkByName.set(fullName, check);

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'gh-del-btn';
            delBtn.textContent = '删除';
            delBtn.title = '只删 ' + fullName;
            delBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                startBatch([fullName], progress);
            });

            a.parentElement.insertBefore(check, a);
            a.parentElement.appendChild(delBtn);
        });

        panel.querySelector('#gh-del-go').addEventListener('click', () => {
            if (!selected.size) return;
            startBatch(Array.from(selected), progress);
        });
        panel.querySelector('#gh-del-select-all').addEventListener('click', () => {
            checkByName.forEach((c, fullName) => { c.checked = true; selected.add(fullName); });
            renderChips();
        });
        panel.querySelector('#gh-del-clear').addEventListener('click', () => {
            selected.clear();
            checkByName.forEach((c) => { c.checked = false; });
            renderChips();
        });
        renderChips();
    }

    async function startBatch(fullNames, progress) {
        const blocked = fullNames.filter(isProtected);
        const allowed = fullNames.filter((n) => !isProtected(n));
        if (blocked.length) alert('已跳过受保护仓库（PROTECTED 里配置的）：\n' + blocked.join('\n'));
        if (!allowed.length) return;
        const ok = await showGhConfirm({
            title: '确认删除 ' + allowed.length + ' 个仓库',
            intro: '脚本会直接发请求逐个删，失败的会留下来用 UI 方式补删。',
            names: allowed,
            confirmText: '确认删除',
            cancelText: '取消',
        });
        if (!ok) return;

        const failed = [];
        if (progress) progress.init(allowed);
        for (const name of allowed) {
            if (progress) progress.set(name, 'run');
            try {
                await deleteViaPost(name);
                if (progress) progress.set(name, 'ok');
            } catch (e) {
                failed.push(name);
                if (progress) progress.set(name, 'fail', e && e.message ? e.message : String(e));
            }
            await sleep(800);
        }
        if (!failed.length) {
            alert('批量删除完成，共 ' + allowed.length + ' 个，全部删成功。');
            location.reload();
            return;
        }
        const goUi = await showGhConfirm({
            title: '有 ' + failed.length + ' 个没删成，用 UI 方式补删？',
            intro: '以下仓库直接 POST 没删成，点确认会逐个打开 Settings 页自动走完三步，点取消就先停下。',
            names: failed,
            confirmText: '用 UI 方式补删',
            cancelText: '先停下',
        });
        if (goUi) {
            setQueue(failed);
            location.href = 'https://github.com/' + failed[0] + '/settings';
        }
    }

    // ================= Settings 页：UI 自动走完三步（回落用） =================
    function isSettingsPage() {
        // 回落流程也只认自己的仓库：/haliChina/<仓库>/settings
        return new RegExp('^/' + OWNER + '/[^/]+/settings/?$').test(location.pathname);
    }
    function currentRepoFullName() {
        const parts = location.pathname.split('/').filter(Boolean);
        if (parts.length >= 2) return parts[0] + '/' + parts[1];
        return '';
    }
    function findButtonByText(text, root) {
        const scope = root || document;
        const btns = scope.querySelectorAll('button, a, [role="button"]');
        for (const b of btns) {
            if ((b.textContent || '').replace(/\s+/g, ' ').trim() === text) return b;
        }
        return null;
    }
    function findButtonContaining(text) {
        for (const b of document.querySelectorAll('button')) {
            if ((b.textContent || '').includes(text)) return b;
        }
        return null;
    }
    async function waitForButton(text, timeoutMs) {
        const deadline = Date.now() + (timeoutMs || 10000);
        while (Date.now() < deadline) {
            const b = findButtonByText(text);
            if (b) return b;
            await sleep(300);
        }
        return null;
    }
    async function waitForInput(timeoutMs) {
        const deadline = Date.now() + (timeoutMs || 10000);
        while (Date.now() < deadline) {
            const input = Array.from(document.querySelectorAll('input')).find((i) => {
                if (i.offsetParent === null) return false;
                const label = (i.closest('label') || {}).textContent || '';
                return /To confirm, type/i.test(label) || /type ".*?" in the box below/i.test((i.parentElement || {}).textContent || '');
            });
            if (input) return input;
            await sleep(300);
        }
        return null;
    }
    function setInputValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function showProgressBar(queue) {
        if (document.getElementById('gh-del-bar')) return;
        ensureGhDelStyles();
        const bar = document.createElement('div');
        bar.id = 'gh-del-bar';
        bar.innerHTML = '<span aria-hidden="true"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M6 1.5a.5.5 0 0 0-.5.5v1h-3a.5.5 0 0 0 0 1h1v9.5A1.5 1.5 0 0 0 5 15h6a1.5 1.5 0 0 0 1.5-1.5V4h1a.5.5 0 0 0 0-1h-3v-1a.5.5 0 0 0-.5-.5h-4zM6 3h4v1H6V3zm1 3.5a.5.5 0 0 1 1 0v4a.5.5 0 0 1-1 0v-4zm3 0a.5.5 0 0 1 1 0v4a.5.5 0 0 1-1 0v-4z"/></svg></span><span>正在批量删除（UI 回落）：还剩 <b>' + queue.length + '</b> 个，当前 <b>' + currentRepoFullName() + '</b>（自动走完三步确认，删完自动跳下一个）</span>'
            + '<button id="gh-del-cancel" type="button">取消批量删除</button>';
        document.body.prepend(bar);
        document.getElementById('gh-del-cancel').addEventListener('click', () => {
            clearQueue();
            bar.remove();
            alert('已取消批量删除，当前这个仓库如果还没点最后一步就不会删。');
        });
    }
    async function autoDeleteCurrent() {
        const queue = getQueue();
        if (!queue.length) return;
        const fullName = currentRepoFullName();
        if (queue[0] !== fullName) return;
        if (isProtected(fullName)) {
            setQueue(queue.slice(1));
            goNext();
            return;
        }
        showProgressBar(queue);
        await sleep(800);
        const dangerBtn = findButtonContaining('Delete this repository');
        if (!dangerBtn) { alert('没找到 Danger Zone 的 Delete this repository 按钮，GitHub 页面可能改版了，已停下。当前仓库没删。'); return; }
        dangerBtn.click();
        const step1 = await waitForButton('I want to delete this repository', 10000);
        if (!step1) { alert('没等到第一步确认按钮，已停下，当前仓库没删。'); return; }
        step1.click();
        const step2 = await waitForButton('I have read and understand these effects', 10000);
        if (!step2) { alert('没等到第二步确认按钮，已停下，当前仓库没删。'); return; }
        step2.click();
        const input = await waitForInput(10000);
        if (!input) { alert('没等到输入仓库名的输入框，已停下，当前仓库没删。'); return; }
        setInputValue(input, fullName);
        await sleep(600);
        const finalBtn = findButtonByText('Delete this repository');
        if (!finalBtn) { alert('没找到最终删除按钮，已停下，当前仓库没删。'); return; }
        if (finalBtn.disabled) { alert('最终删除按钮还是禁用状态，已停下，当前仓库没删。'); return; }
        setQueue(queue.slice(1));
        finalBtn.click();
    }
    function goNext() {
        const rest = getQueue();
        if (!rest.length) {
            clearQueue();
            alert('批量删除完成。');
            location.href = 'https://github.com/' + OWNER + '?tab=repositories';
            return;
        }
        location.href = 'https://github.com/' + rest[0] + '/settings';
    }

    // ================= 入口 =================
    (function main() {
        if (isSettingsPage()) { autoDeleteCurrent(); return; }
        if (isRepoListPage()) {
            injectListUI();
            const queue = getQueue();
            if (queue.length) {
                const rest = queue.filter((n) => !isProtected(n));
                setQueue(rest);
                if (rest.length) {
                    setTimeout(() => {
                        showGhConfirm({
                            title: 'UI 回落的批量删除进行中',
                            intro: '还剩 ' + rest.length + ' 个，点确认继续删下一个，点取消就停下。',
                            names: rest,
                            confirmText: '继续删除',
                            cancelText: '停下',
                        }).then((ok) => {
                            if (ok) location.href = 'https://github.com/' + rest[0] + '/settings';
                            else clearQueue();
                        });
                    }, 600);
                } else {
                    clearQueue();
                }
            }
            return;
        }
    })();
})();
