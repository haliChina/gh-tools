// ==UserScript==
// @name         GitHub 批量隐藏 Codex 评论
// @namespace    https://github.com/haliChina/gh-tools
// @version      1.1.0
// @description  在 PR / Issue 页一键批量隐藏 chatgpt-codex-connector（Codex bot）的评论与 review。按真实抓包的 minimize-comment 请求发，不猜接口。
// @author       haliChina
// @match        *://github.com/*/*/pull/*
// @match        *://github.com/*/*/issues/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 实测依据（2026-11-12，用户在 Edge 里手动隐藏一条 Codex 评论时导出的 HAR）：
 * - 先 GET /<owner>/<repo>/issue_comments/6755536642/comment_actions_menu?gid=IC_kwDOUwoVys8AAAABkqlPAg
 *   —— gid 就是评论的 GraphQL node id，页面里每个评论容器上都带 data-gid。
 * - 隐藏本体：POST https://github.com/haliChina/SecAgent/community/minimize-comment → 200
 *   Content-Type: multipart/form-data，带 X-Requested-With: XMLHttpRequest
 *   请求体 4 个字段：_method=put、authenticity_token、comment_id=<gid>、classifier=LOW_QUALITY
 * - 隐藏后页面再 GET /comments/<gid>/partials/timeline_issue_comment 刷新那条评论。
 *
 * authenticity_token 每次从当前页面现取，不缓存、不硬编码。
 * classifier 用户实测用的就是 LOW_QUALITY（低质量）；GitHub 还接受
 * SPAM / ABUSE / OFF_TOPIC / OUTDATED / DUPLICATE / RESOLVED，要改改下面配置。
 *
 * DOM 依据（2026-11-12 实测 PR 页 HTML）：
 * - 普通评论的容器带 data-gid="IC_..."，review 的容器带 data-gid="PRR_..."，
 *   review 里的单条评论带 data-gid="PRRC_..."。
 * - Codex 的作者链接固定是 /apps/chatgpt-codex-connector，按它找作者最稳。
 * - 已隐藏的评论，其容器里会有 .minimized-comment，扫描时跳过并计数。
 *   注意未隐藏的评论带的是 unminimized-comment 类，是另一个类名，别混。
 *
 * v1.0.1（2026-11-12 实测修正）：首跑 13 条里 6 条成功、7 条 usage limits 评论
 * 两次尝试都回 HTTP 422。事后核对：那 7 条跑之前就是未隐藏状态，DOM 结构与
 * 成功的 6 条完全一致，所以不是已隐藏也不是扫描误判。v1.0.1 改两处：失败时
 * 把 GitHub 的响应原文显示在状态行（422 的原因看原文定性）；token 改成多来源
 * 轮试（目标评论自己容器里的、全页第一个、现抓的新鲜 token），排除 token
 * 出处不对这一种可能。响应原文含 already 的按已隐藏处理，不算失败。
 *
 * v1.1.0：加内容过滤（用户要求，可选）。默认只隐藏含超限额文案的评论
 * （You have reached your Codex usage limits for code reviews. 开头那类
 * 通知），真正的 code review 不动。过滤开关和文案在浮窗里可改，关掉
 * 过滤就处理全部 Codex 评论。
 *
 * 安全：
 * - 只处理页面上已经加载出来的评论；没加载的（分页 / Load more）点“重新扫描”再跑一遍。
 * - 开始前有确认框，列出要隐藏的条数和理由；不会一打开页面就自动隐藏。
 * - 隐藏不是删除，之后还能在页面上逐条手动取消隐藏。
 * - 只在 PR / Issue 详情页出现浮窗（@match 已限制），其他页面不触发。
 */

(function () {
    'use strict';

    // ===== 可改配置 =====
    const TARGET_AUTHOR = 'chatgpt-codex-connector'; // 要隐藏的 bot 作者（/apps/<这个名字>）
    const CLASSIFIER = 'LOW_QUALITY'; // 隐藏理由，用户实测用的就是这个
    const DELAY_MS = 300; // 每条之间间隔，别打太快
    // 内容过滤默认值：只隐藏含这段文案的评论（超限额通知）；浮窗里可改、可靠边关
    const DEFAULT_FILTER_TEXT = 'You have reached your Codex usage limits for code reviews';

    // ================= 页面判断 =================
    function parsePage() {
        const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)\/?$/);
        if (!m) return null;
        return { owner: m[1], repo: m[2], kind: m[3], number: m[4] };
    }

    // ================= token：每次现取 =================
    function tokenFromDocument(doc) {
        const input = doc.querySelector('input[name="authenticity_token"]');
        return input ? input.value : '';
    }
    async function getToken() {
        const token = tokenFromDocument(document);
        if (token) return token;
        return getFreshToken();
    }
    async function getFreshToken() {
        const res = await fetch(location.href, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('重新打开当前页失败，HTTP ' + res.status);
        const html = await res.text();
        const token = tokenFromDocument(new DOMParser().parseFromString(html, 'text/html'));
        if (!token) throw new Error('在当前页没找到 authenticity_token，可能没登录');
        return token;
    }
    // 候选 token：先用目标评论自己容器里的，再用全页第一个
    function tokensFor(unit, pageToken) {
        const list = [];
        const push = (t) => { if (t && !list.includes(t)) list.push(t); };
        if (unit.el) {
            const own = unit.el.querySelector('input[name="authenticity_token"]');
            push(own ? own.value : '');
        }
        push(pageToken);
        return list;
    }

    // ================= 扫描 Codex 评论 =================
    function findCodexUnits() {
        const units = new Map(); // gid -> { gid, label, minimized }
        document.querySelectorAll('a[href="/apps/' + TARGET_AUTHOR + '"]').forEach((a) => {
            const host = a.closest('.js-minimize-container[data-gid], .js-timeline-item[data-gid], [data-gid]');
            if (!host) return;
            const gid = host.getAttribute('data-gid') || '';
            if (!/^(IC|PRR|PRRC)_/.test(gid)) return;
            if (units.has(gid)) return;
            const link = host.querySelector('a[href*="#issuecomment-"], a[href*="#discussion_r"], a[href*="#pullrequestreview-"]');
            units.set(gid, {
                gid,
                el: host,
                label: link ? link.getAttribute('href') : gid,
                minimized: !!host.querySelector('.minimized-comment'),
                text: (host.innerText || host.textContent || '').replace(/\s+/g, ' '),
            });
        });
        return Array.from(units.values());
    }

    // ================= 隐藏一条 =================
    // 返回 { ok } 或 { ok:false, status, body }；body 是 GitHub 的原话，422 时靠它定性
    async function minimizeOne(page, gid, token) {
        const fd = new FormData();
        fd.append('_method', 'put');
        fd.append('authenticity_token', token);
        fd.append('comment_id', gid);
        fd.append('classifier', CLASSIFIER);
        const res = await fetch('https://github.com/' + page.owner + '/' + page.repo + '/community/minimize-comment', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            body: fd,
        });
        if (res.ok) return { ok: true };
        const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 180);
        return { ok: false, status: res.status, body };
    }
    // 依次试候选 token；全 422 再现抓一个新鲜 token 试最后一次
    async function minimizeWithTokens(page, unit, pageToken) {
        const candidates = tokensFor(unit, pageToken);
        let last = null;
        for (const t of candidates) {
            last = await minimizeOne(page, unit.gid, t);
            if (last.ok) return last;
            if (last.status !== 422) break;
        }
        if (last && !last.ok && last.status === 422) {
            try {
                const fresh = await getFreshToken();
                if (!candidates.includes(fresh)) {
                    const retry = await minimizeOne(page, unit.gid, fresh);
                    if (retry.ok) return retry;
                    last = retry;
                }
            } catch (e) { /* 现抓失败就用上一次的结果 */ }
        }
        return last || { ok: false, status: 0, body: '没发出请求' };
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ================= UI：Primer 风格（与 gh-tools 其他脚本一致，无 emoji） =================
    function ensureStyles() {
        if (document.getElementById('gh-hide-style')) return;
        const style = document.createElement('style');
        style.id = 'gh-hide-style';
        style.textContent = `
            #gh-hide-panel, #gh-hide-modal-overlay {
                --gh-bg: #ffffff; --gh-bg-subtle: #f6f8fa; --gh-bg-danger-subtle: #ffebe9;
                --gh-border: #d0d7de; --gh-text: #1f2328; --gh-text-muted: #656d76;
                --gh-danger: #d1242f; --gh-danger-hover: #a40e26;
                --gh-success: #1a7f37;
                --gh-shadow: 0 8px 24px rgba(140, 149, 159, 0.2);
            }
            html[data-color-mode="dark"] #gh-hide-panel, html[data-color-mode="dark"] #gh-hide-modal-overlay {
                --gh-bg: #0d1117; --gh-bg-subtle: #161b22; --gh-bg-danger-subtle: #3d1215;
                --gh-border: #30363d; --gh-text: #e6edf3; --gh-text-muted: #8b949e;
                --gh-danger: #f85149; --gh-danger-hover: #ff7b72;
                --gh-success: #3fb950;
                --gh-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
            }
            @media (prefers-color-scheme: dark) {
                #gh-hide-panel, #gh-hide-modal-overlay {
                    --gh-bg: #0d1117; --gh-bg-subtle: #161b22; --gh-bg-danger-subtle: #3d1215;
                    --gh-border: #30363d; --gh-text: #e6edf3; --gh-text-muted: #8b949e;
                    --gh-danger: #f85149; --gh-danger-hover: #ff7b72;
                    --gh-success: #3fb950;
                    --gh-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
                }
            }
            #gh-hide-panel { position: fixed; right: 16px; bottom: 16px; z-index: 9999; width: 380px; max-width: calc(100vw - 32px); background: var(--gh-bg); color: var(--gh-text); border: 1px solid var(--gh-border); border-radius: 12px; box-shadow: var(--gh-shadow); padding: 14px 16px; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            #gh-hide-panel .gh-hide-head { display: flex; align-items: center; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid var(--gh-border); margin-bottom: 10px; font-size: 14px; font-weight: 600; }
            #gh-hide-panel .gh-hide-badge { background: var(--gh-danger); color: #fff; border-radius: 999px; padding: 0 8px; font-size: 12px; font-weight: 600; line-height: 20px; min-width: 20px; text-align: center; }
            #gh-hide-panel .gh-hide-ver { margin-left: auto; font-size: 11px; font-weight: 400; color: var(--gh-text-muted); }
            #gh-hide-panel .gh-hide-toggle { cursor: pointer; background: transparent; border: 1px solid var(--gh-border); color: var(--gh-text-muted); border-radius: 6px; padding: 0 8px; font-size: 12px; line-height: 20px; }
            #gh-hide-panel.gh-hide-collapsed > :not(.gh-hide-head) { display: none; }
            #gh-hide-panel.gh-hide-collapsed .gh-hide-head { padding-bottom: 0; border-bottom: none; margin-bottom: 0; }
            @media (max-width: 640px) { #gh-hide-panel { right: 8px; bottom: 8px; width: calc(100vw - 16px); } }
            #gh-hide-panel .gh-hide-sub { color: var(--gh-text-muted); font-size: 12px; margin-bottom: 8px; }
            #gh-hide-panel .gh-hide-filter { margin-bottom: 10px; font-size: 12px; color: var(--gh-text-muted); }
            #gh-hide-panel .gh-hide-filter label { display: flex; align-items: center; gap: 6px; cursor: pointer; margin-bottom: 6px; }
            #gh-hide-panel .gh-hide-filter input[type="text"] { width: 100%; box-sizing: border-box; padding: 5px 8px; border: 1px solid var(--gh-border); border-radius: 6px; background: var(--gh-bg); color: var(--gh-text); font-size: 12px; }
            #gh-hide-panel .gh-hide-actions { display: flex; gap: 8px; flex-wrap: wrap; }
            #gh-hide-panel .gh-hide-actions button { cursor: pointer; padding: 5px 12px; border-radius: 6px; font-size: 13px; font-weight: 500; line-height: 20px; }
            .gh-hide-btn-primary { background: var(--gh-danger); color: #fff; border: 1px solid var(--gh-danger); }
            .gh-hide-btn-primary:hover { background: var(--gh-danger-hover); border-color: var(--gh-danger-hover); }
            .gh-hide-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
            .gh-hide-btn-secondary { background: transparent; color: var(--gh-text); border: 1px solid var(--gh-border); }
            .gh-hide-btn-secondary:hover { background: var(--gh-bg-subtle); }
            #gh-hide-progress-wrap { margin-top: 12px; border-top: 1px solid var(--gh-border); padding-top: 10px; }
            #gh-hide-progress-wrap[hidden] { display: none; }
            .gh-hide-progress { height: 8px; background: var(--gh-bg-subtle); border: 1px solid var(--gh-border); border-radius: 999px; overflow: hidden; }
            .gh-hide-progress > div { height: 100%; width: 0%; background: var(--gh-danger); transition: width 0.3s ease; }
            #gh-hide-progress-text { font-size: 12px; color: var(--gh-text-muted); margin: 6px 0 2px; }
            .gh-hide-status-row { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-top: 1px solid var(--gh-border); font-size: 12px; word-break: break-all; }
            .gh-hide-status-row:first-child { border-top: none; }
            .gh-hide-status-ico { flex: none; width: 12px; height: 12px; border-radius: 50%; margin-top: 3px; }
            .gh-hide-status-ok { background: var(--gh-success); }
            .gh-hide-status-fail { background: var(--gh-danger); }
            .gh-hide-status-run { background: transparent; border: 2px solid var(--gh-border); border-top-color: var(--gh-danger); }
            .gh-hide-spin { display: inline-block; animation: gh-hide-spin 1s linear infinite; }
            @keyframes gh-hide-spin { to { transform: rotate(360deg); } }
            .gh-hide-status-reason { color: var(--gh-text-muted); }
            #gh-hide-modal-overlay { position: fixed; inset: 0; z-index: 10000; background: rgba(31, 35, 40, 0.6); display: flex; align-items: center; justify-content: center; padding: 16px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            .gh-hide-modal { width: 440px; max-width: 100%; max-height: 84vh; overflow: auto; background: var(--gh-bg); color: var(--gh-text); border: 1px solid var(--gh-border); border-radius: 12px; box-shadow: var(--gh-shadow); padding: 16px; }
            .gh-hide-modal h3 { margin: 0 0 8px; font-size: 16px; }
            .gh-hide-modal p { margin: 0 0 8px; color: var(--gh-text-muted); font-size: 13px; }
            .gh-hide-modal .gh-hide-warn { background: var(--gh-bg-danger-subtle); border: 1px solid var(--gh-danger); color: var(--gh-danger); border-radius: 8px; padding: 8px 12px; font-size: 13px; font-weight: 600; margin-bottom: 14px; }
            .gh-hide-modal .gh-hide-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
            .gh-hide-modal .gh-hide-modal-actions button { cursor: pointer; padding: 5px 12px; border-radius: 6px; font-size: 13px; font-weight: 500; line-height: 20px; }
        `;
        document.head.appendChild(style);
    }

    function showConfirm(opts) {
        ensureStyles();
        return new Promise((resolve) => {
            document.getElementById('gh-hide-modal-overlay')?.remove();
            const overlay = document.createElement('div');
            overlay.id = 'gh-hide-modal-overlay';
            overlay.innerHTML = '<div class="gh-hide-modal" role="dialog" aria-modal="true">'
                + '<h3>' + opts.title + '</h3>'
                + (opts.intro ? '<p>' + opts.intro + '</p>' : '')
                + '<div class="gh-hide-warn">' + opts.warn + '</div>'
                + '<div class="gh-hide-modal-actions">'
                + '<button type="button" class="gh-hide-btn-secondary" data-act="cancel">' + (opts.cancelText || '取消') + '</button>'
                + '<button type="button" class="gh-hide-btn-primary" data-act="confirm">' + (opts.confirmText || '确认') + '</button>'
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

    function injectPanel(page) {
        if (document.getElementById('gh-hide-panel')) return;
        ensureStyles();

        const panel = document.createElement('div');
        panel.id = 'gh-hide-panel';
        panel.innerHTML = '<div class="gh-hide-head"><span>隐藏 Codex 评论</span>'
            + '<span class="gh-hide-badge" id="gh-hide-count">0</span>'
            + '<span class="gh-hide-ver">v1.1.0 · ' + CLASSIFIER + '</span>'
            + '<button type="button" class="gh-hide-toggle" id="gh-hide-toggle">收起</button></div>'
            + '<div class="gh-hide-sub" id="gh-hide-stats">正在扫描本页已加载的评论。</div>'
            + '<div class="gh-hide-filter"><label><input type="checkbox" id="gh-hide-filter-on" checked> 只隐藏含指定内容的评论（默认是超限额通知）</label>'
            + '<input type="text" id="gh-hide-filter-text" value="' + DEFAULT_FILTER_TEXT.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"></div>'
            + '<div class="gh-hide-actions">'
            + '<button type="button" class="gh-hide-btn-primary" id="gh-hide-go">隐藏全部</button>'
            + '<button type="button" class="gh-hide-btn-secondary" id="gh-hide-rescan">重新扫描</button>'
            + '</div>'
            + '<div id="gh-hide-progress-wrap" hidden>'
            + '<div class="gh-hide-progress"><div id="gh-hide-progress-bar"></div></div>'
            + '<div id="gh-hide-progress-text"></div>'
            + '<div id="gh-hide-status"></div>'
            + '</div>';
        document.body.appendChild(panel);

        const toggleBtn = panel.querySelector('#gh-hide-toggle');
        toggleBtn.addEventListener('click', () => {
            const collapsed = panel.classList.toggle('gh-hide-collapsed');
            toggleBtn.textContent = collapsed ? '展开' : '收起';
        });
        if (window.innerWidth <= 640) {
            panel.classList.add('gh-hide-collapsed');
            toggleBtn.textContent = '展开';
        }

        const countEl = panel.querySelector('#gh-hide-count');
        const statsEl = panel.querySelector('#gh-hide-stats');
        const goBtn = panel.querySelector('#gh-hide-go');
        const progressWrap = panel.querySelector('#gh-hide-progress-wrap');
        const progressBar = panel.querySelector('#gh-hide-progress-bar');
        const progressText = panel.querySelector('#gh-hide-progress-text');
        const statusEl = panel.querySelector('#gh-hide-status');

        const filterOnEl = panel.querySelector('#gh-hide-filter-on');
        const filterTextEl = panel.querySelector('#gh-hide-filter-text');
        let pending = [];
        function rescan() {
            const units = findCodexUnits();
            const hidden = units.filter((u) => u.minimized).length;
            const filterOn = filterOnEl.checked;
            const kw = filterTextEl.value.trim();
            const match = (u) => !filterOn || !kw || u.text.includes(kw);
            pending = units.filter((u) => !u.minimized && match(u));
            const skipped = units.length - hidden - pending.length;
            countEl.textContent = String(pending.length);
            statsEl.textContent = '本页已加载的 Codex 评论共 ' + units.length + ' 条，已隐藏 ' + hidden + ' 条，待隐藏 ' + pending.length + ' 条'
                + (filterOn ? '，内容不符合、不处理的 ' + skipped + ' 条' : '')
                + '。没加载出来的先滚动或点 Load more，再点重新扫描。';
            goBtn.disabled = pending.length === 0;
        }
        filterOnEl.addEventListener('change', rescan);
        filterTextEl.addEventListener('input', rescan);

        const progress = {
            total: 0, done: 0, rows: new Map(),
            init(items) {
                this.total = items.length; this.done = 0; this.rows = new Map();
                progressWrap.hidden = false;
                progressBar.style.width = '0%';
                progressText.textContent = '准备隐藏 0 / ' + items.length;
                statusEl.innerHTML = '';
                items.forEach((u) => {
                    const row = document.createElement('div');
                    row.className = 'gh-hide-status-row';
                    row.innerHTML = '<span class="gh-hide-status-ico gh-hide-status-run gh-hide-spin"></span><span></span>';
                    row.lastChild.textContent = u.label;
                    statusEl.appendChild(row);
                    this.rows.set(u.gid, row);
                });
            },
            set(gid, state, reason) {
                const row = this.rows.get(gid);
                if (!row) return;
                const ico = row.querySelector('.gh-hide-status-ico');
                if (state === 'run') { ico.className = 'gh-hide-status-ico gh-hide-status-run gh-hide-spin'; }
                if (state === 'ok') { ico.className = 'gh-hide-status-ico gh-hide-status-ok'; this.done += 1; }
                if (state === 'fail') {
                    ico.className = 'gh-hide-status-ico gh-hide-status-fail'; this.done += 1;
                    const r = document.createElement('div');
                    r.className = 'gh-hide-status-reason';
                    r.textContent = reason || '';
                    row.appendChild(r);
                }
                progressBar.style.width = Math.round((this.done / Math.max(this.total, 1)) * 100) + '%';
                progressText.textContent = '已完成 ' + this.done + ' / ' + this.total;
            },
        };

        goBtn.addEventListener('click', async () => {
            if (!pending.length) return;
            const targets = pending.slice();
            const ok = await showConfirm({
                title: '确认隐藏 ' + targets.length + ' 条 Codex 评论',
                intro: '将逐条向 GitHub 发隐藏请求，理由是 ' + CLASSIFIER + '（低质量）。只处理本页已加载的评论。'
                    + (filterOnEl.checked ? '本次只隐藏含指定内容的评论（超限额通知那类），真正的 review 不动。' : ''),
                warn: '隐藏不是删除，之后可以在页面上逐条手动取消隐藏',
                confirmText: '确认隐藏',
                cancelText: '取消',
            });
            if (!ok) return;

            goBtn.disabled = true;
            let pageToken;
            try {
                pageToken = await getToken();
            } catch (e) {
                alert('取 token 失败：' + (e && e.message ? e.message : String(e)));
                goBtn.disabled = false;
                return;
            }
            progress.init(targets);
            const failed = [];
            for (const u of targets) {
                progress.set(u.gid, 'run');
                const r = await minimizeWithTokens(page, u, pageToken);
                if (r.ok || /already/i.test(r.body || '')) {
                    progress.set(u.gid, 'ok');
                } else {
                    failed.push(u);
                    progress.set(u.gid, 'fail', 'HTTP ' + r.status + (r.body ? '：' + r.body : ''));
                }
                await sleep(DELAY_MS);
            }
            if (!failed.length) {
                alert('全部隐藏完成，共 ' + targets.length + ' 条。页面刷新后生效，正在刷新。');
                location.reload();
                return;
            }
            alert('隐藏完成，但有 ' + failed.length + ' 条没成，原因见浮窗列表。可以重新扫描后再试。');
            rescan();
            goBtn.disabled = pending.length === 0;
        });
        panel.querySelector('#gh-hide-rescan').addEventListener('click', rescan);
        rescan();
    }

    // ================= 入口 =================
    (function main() {
        const page = parsePage();
        if (!page) return;
        injectPanel(page);
    })();
})();
