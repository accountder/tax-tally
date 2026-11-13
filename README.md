# TaxTally · 发票金额助手

> 把电子税务局发票查询页的「合计金额 / 合计税额」直接换算成**万元**显示，一眼看清量级；附带阈值高亮、批量汇总、CSV 导出和快捷办税菜单。
>
> A Chrome extension (Manifest V3) that renders invoice totals in **万元 (10k CNY)** on the Hubei e-Tax invoice query page — without touching the original numbers.

> ⚠️ **非官方工具**。与国家税务总局无关，不是官方客户端。它只做「显示」和「快捷操作」，不会替你申报、开票或提交任何数据。

---

## English overview

TaxTally is a small Manifest V3 extension for the Hubei Provincial e-Tax Bureau portal
(`*.hubei.chinatax.gov.cn:8443`). Its core job: the invoice query page shows totals like
`1234567.89 元`, which is hard to sanity-check at a glance. TaxTally renders a red overlay
above that line showing `123.4568 万元`, **leaving the original digits untouched** so the page
and any script reading it still see the real values.

It also highlights totals above a configurable threshold, can auto-refresh the login page on a
timer, runs a quarter-by-quarter / month-by-month batch query and exports the result as CSV,
and adds a floating shortcut menu to jump between common tax tasks.

No network requests. No telemetry. No remote code. Settings live in `chrome.storage`.

---

## 功能

### 1. 万元浮层（核心）

- 在「合计金额 / 合计税额」原数字**上方**叠加一层红色数值，原数字一个字符都不改
- 金额、税额可分别开关
- 10 万 → `10.0000 万元`；超 1 亿自动切成**亿元**（`150,000,000` → `1.5000 亿元`）
- 小数位、颜色、字号、加粗都可调；悬停显示精确到分的原始元值，点击可复制
- 三种模式：`浮层`（推荐）/ `行内追加` / `关闭`

> 为什么坚持不改原数字：原数字是页面 Vue 实例的数据源，改动它会让「复制」「导出」以及后续查询拿到错误值。浮层是纯视觉层，删掉即恢复原样。

### 2. 阈值高亮

- 合计金额超过设定值（默认 30 万）时，原始合计数字变红；回落到阈值以下会自动恢复颜色
- 「数电发票（增值税专用发票）」这类单据行可单独高亮，方便快速定位专票

### 3. 定时刷新

- 默认**只在** `https://etax.hubei.chinatax.gov.cn:8443/loginb/` 生效，开票、查询等其他页面一律不刷，不会打断你正在填的表单
- 间隔可设，页面右下角有倒计时浮标
- 刷新后可自动恢复上次的查询条件并重新查询（仅在查询页有效）

### 4. 批量汇总 + CSV 导出

- 指定年份，按 **季度（4 段）** 或 **按月（12 段）** 自动跑一遍：填日期 → 点查询 → 等汇总稳定 → 读值 → 累加
- 结果以浮层表格实时显示，含合计行，一键导出 CSV（带 BOM，Excel 双击不乱码）
- 也可单独导出当前页表格

### 5. 快捷办税菜单

悬浮在页面右上角，**仅**在 `https://etax.hubei.chinatax.gov.cn:8443` 出现：

自动填充 · 身份切换 · 复制开票 · 蓝字开具 · 红字开具 · 全量查询 · 信息查询 · 未申报查询 · 重置账号

### 6. 其他

- **跨域账号填充**：登录页一键填信用代码 / 手机号 / 密码（见下方「隐私」一节，务必先读）
- **dppt 返回入口**：发票查询页右上角「← 返回税务首页」，跳回 `/loginb/`
- **设置面板**：4 个标签页（万元 / 高亮 / 刷新 / 工具），顶部实时回显当前页状态与识别到的合计金额

---

## 安装

1. 下载或克隆本仓库

   ```bash
   git clone https://github.com/accountder/tax-tally.git
   ```

   也可以在 GitHub 页面点 `Code → Download ZIP` 后解压。
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），右上角开启**开发者模式**
3. 点「加载已解压的扩展程序」，选择**包含 `manifest.json` 的目录**
4. 打开湖北电子税务局，进入「全量发票查询」，查询一次即可看到红色万元浮层

> ⚠️ 目录名和文件名不要以 `_` 开头（例如 `_bak/`）。Chrome 会拒绝加载并报
> `Filenames starting with "_" are reserved for use by the system.`，把备份放到本目录之外即可。

---

## 隐私

**这个扩展不做任何网络请求，没有统计、没有远程代码，所有数据都在你自己的浏览器里。**

但它有一个功能需要你知情：**「自动填充」会把信用代码 / 手机号 / 密码存在 `chrome.storage.local`**。
`chrome.storage.local` 是**未加密**的本地存储，能读到你这台电脑文件的程序就能读到它。

- 不用自动填充的话，**不要点**「自动填充」，就不会有任何账号信息被写入
- 已经填过的，点菜单里的「🧹 重置账号」清空
- 公开使用建议：改成只用 `chrome.storage.session`（关浏览器即清）或干脆不保存密码

细节见 [PRIVACY.md](PRIVACY.md)。

---

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存显示设置、刷新设置、可选保存的登录账号 |
| `clipboardWrite` | 点击万元数值时复制原始金额 |
| `host_permissions` `*://*.hubei.chinatax.gov.cn/*` | 只在这三个域名注入脚本：`etax` / `dppt` / `tpass` |

没有 `tabs`、没有 `webRequest`、没有 `<all_urls>`。

---

## 适配其他省份

本扩展的页面选择器和快捷菜单是照着**湖北**的页面结构写的。换省份一般要改三处：

| 位置 | 说明 |
| --- | --- |
| `manifest.json` → `host_permissions` / `content_scripts.matches` | 换成对应省份的域名 |
| `content.js` → `config.summarySelector` / `totalAmountSelector` / `totalTaxSelector` | 承载「合计金额」的容器与两个数值节点 |
| `content.js` → `quickNavConfig.menuOrigins` / `links` | 快捷菜单的生效域名与菜单项地址 |

如果页面结构不一样，`readSummary()` 抓不到数就整条链路都不动——它不会瞎猜，抓不到就静默跳过。

---

## 技术说明

几个踩过的坑，写下来省得后来人重踩：

**1. 原数字不能改**
页面是 Vue 3 生产构建，汇总数字由组件状态渲染。直接改 DOM 文本会被下一次重渲染覆盖，而且会污染页面自身的数据源。做法是在原数字的**父容器**里插一个绝对定位的浮层（`position:absolute; bottom:100%`），完全不参与原有布局。

**2. 后台标签页的定时器会被节流**
`setInterval` 在后台标签页会被 Chrome 压到 ≥1 分钟一次。所以刷新逻辑不能只靠定时器，要配合 `visibilitychange` / `scroll` / `resize` 补触发，并用 `MutationObserver` 处理 Vue 重渲染后浮层被清掉的问题。

**3. dppt 页的外链安全 SDK 会吞掉 `<a href>` 的点击**
发票查询页装了外链安全 SDK：点击 `<a>` 时它会 `preventDefault()`，同时把 `href` 改写成 `?XXXX=<几千字符的令牌>`，然后**并不真正跳转**——表现就是「按钮点了没反应」。
解决办法是**不要用 `<a href>`**：改用 `div[role=button]`（无 `href`，SDK 不认），在 `window` 捕获阶段监听 `pointerdown` + `click`，`stopImmediatePropagation()` 后自己 `location.assign()`。程序化跳转不受 `preventDefault()` 影响。

**4. CDP 调试时 `Input.dispatchMouseEvent` 对非活动标签页无效**
事件根本不会派发，`window` 上的捕获计数为 0，很容易误判成「元素被遮挡」。测之前必须 `Target.activateTarget`。

---

## 目录结构

```
.
├── manifest.json     # MV3 清单
├── content.js        # 全部页面逻辑（注入到税务页面）
├── popup.html        # 设置面板
├── popup.js          # 面板逻辑与预览
├── icon16/48/128.png
├── README.md
├── PRIVACY.md
├── CHANGELOG.md
└── LICENSE
```

`content.js` 结构（按注释分段）：全局配置 → 用户设置 → 万元浮层 → 阈值/类型高亮 → 快捷菜单 → 跨域账号 → 日期与查询 → 批量汇总 → CSV → dppt 返回 → 面板状态 → 启动。

---

## 已知限制

- 单次查询有条数上限，查整年可能被截断；用「批量汇总」按季/按月分段更稳
- 批量汇总和定时刷新在**后台标签页**会变慢（Chrome 定时器节流），需要准时的话把页面切到前台
- 依赖页面 DOM 结构，税务系统改版后选择器可能需要更新
- 只在 Chrome / Edge 桌面版测试过

---

## 免责声明

本项目为个人效率工具，**与国家税务总局及各地电子税务局无任何关系**，未经其认可或授权。

- 不修改任何原始数据，不代为申报、开票、提交
- 使用前请自行确认符合当地税务机关对办税系统的使用要求
- 因使用本工具造成的任何后果（包括但不限于数据错误、账号风险、违反平台规则）由使用者自负

---

## License

[MIT](LICENSE)
