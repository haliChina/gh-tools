# gh-tools

GitHub 实用油猴脚本：批量删仓库、网络抓包。两个脚本都只在你自己的页面上触发，不会在别人的仓库页出现。

## 脚本

| 脚本 | 版本 | 说明 |
| --- | --- | --- |
| [github-repo-cleaner.user.js](github-repo-cleaner.user.js) | v2.3.0 | 在自己的仓库列表页勾选多个仓库批量删除 |
| [network-debug.user.js](network-debug.user.js) | v1.2.0 | 拦截 fetch / XHR / 表单提交并记日志，刷新不清除 |

## 安装

1. 浏览器装 Tampermonkey（或 Violentmonkey）。
2. 点上面两个脚本的链接，再点 Tampermonkey 的“安装”。
3. 删仓脚本：打开 https://github.com/haliChina?tab=repositories ，右下角会出现浮窗。
4. 抓包脚本：装好后在任意页面右下角出现 NetDebug 浮窗。

## 删仓脚本用法

1. 在仓库列表页，每行仓库后面会出现复选框和“删除”按钮。
2. 勾选要删的仓库，点浮窗里的“删除选中”；也可以直接点某一行的“删除”只删那一个。
3. 确认框会逐个列出仓库全名，确认后脚本在列表页直接发请求逐个删。
4. 删完一个在浮窗里打勾，全部跑完出汇总。失败的会列出来，点“用 UI 方式补删”会逐个打开 Settings 页自动走完三步。

安全说明：

- 删除不可逆，GitHub 没有回收站，确认框列出的名字请逐个核对。
- 批量开始前必须在确认框里再点一次确认，脚本不会一打开页面就自动删。
- 受保护的仓库写在脚本顶部的 `PROTECTED` 数组里，勾选、删除时会被直接跳过（当前为空，需要保护哪个仓库就把仓库名加进去）。
- 只在自己的仓库列表页触发：路径必须是 `/haliChina` 且 `tab=repositories`，标题含 Repositories 或页头显示 Your Repositories 才认；别人的仓库页不会出现浮窗与复选框。Settings 页回落也只认 `/haliChina/<仓库>/settings`。
- 手机等窄屏上浮窗默认收起，只留标题栏，点“展开”再打开。

## 抓包脚本用法

1. 装好后右下角出现 NetDebug 浮窗，右上角显示“录制中”。
2. 正常操作页面（比如走 Danger Zone 删除流程），页面发出的 fetch / XHR / 表单提交都会被记下来。
3. 过滤框搜关键词（比如 `delete` 或 `settings`），点一条记录展开，看 method、URL、请求头、请求体、状态码和响应。
4. 单条记录可以复制 URL、复制 cURL 或复制整条 JSON，也可以点“导出 JSON”保存全部日志。

持久化与隐私：

- 日志存在 GM 存储（主）+ localStorage（备），刷新、跳转、关掉重开都在，只有手动点“清空”才会删；上限 300 条，超了删最旧的，每条请求体/响应各截断到 4000 字。
- 敏感字段（authenticity_token / password / token / secret 等）的值默认打码，只留首尾 4 位，字段名完整保留；点“显示敏感值”可临时看全（仅当前页显示，不改已存日志）。

## 实测依据（删仓脚本）

2026-11-07，用 Network Debug 脚本抓到的真实删除记录：

- 12:21:28.933，一条表单提交记录，就是删 `haliChina/test2` 的那次：`POST https://github.com/haliChina/test2/settings/delete`，请求体 4 个字段：`_method=delete`、`authenticity_token`、`verification_field=haliChina/test2`、`verify=haliChina/test2`。
- 删完跳回仓库列表页，随后列表页正常加载；`test2` 再访问已是 404，确认删成功了。
- 其余 41 条全是噪音：7 条 Datadog RUM 上报（请求体是 deflate 压缩的二进制）和 34 条仓库列表页的 participation 迷你图 GET。

所以 v2 改成直接 POST，流程：`GET https://github.com/<owner>/<repo>/settings`，从里面的删除表单现取 `authenticity_token`，再 POST 到上面那个地址，带上面 4 个字段，最后再 GET 一次仓库页，返回 404 才算删成功。token 不缓存、不硬编码，每次现取现用。取不到 token 或 POST 失败时，自动回落到 v1 的 UI 方式：打开 Settings 页自动点三步确认。

更早的 2026-11-07 12:07，`haliChina/testrepo`（描述和 README 均为“test delete1”，仅 1 次提交）走 Settings → Danger Zone → Delete this repository 三步确认删掉，删后整页跳回仓库列表页并显示成功横幅，再访问该地址为 404，已验证删除成功。

## 更新记录

- v2.3.0（删仓）：只在自己的仓库列表页触发（按 owner + Your Repositories 标题判断）；窄屏浮窗默认收起。
- v2.2.0（删仓）/ v1.2.0（抓包）：去掉全部 emoji / 符号图标，改用文字、CSS 圆点与 SVG。
- v2.1.0（删仓）/ v1.1.0（抓包）：Primer 风格浮窗 + 深色适配；删仓加已选 chips、进度条、自定义确认弹窗；抓包加分段筛选、卡片式日志、可收起。
- v2.0.0（删仓）：按上面抓到的真实请求改成直接 POST 删除，失败回落 UI 三步。
- v1.0.0：两个脚本首版。
