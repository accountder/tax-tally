// =====================================================
// === 1. 全局配置与状态 ===
// =====================================================
const config = {
    totalAmountSelector: ".info-number:nth-child(1)", 
    totalTaxSelector: ".info-number:nth-child(2)",    
    highlightThreshold: 300000,
    highlightColor: "#ff4d4f",
    storageKey: "plugin_tax_user_info",

    // —— 万元显示（新增）——
    // "overlay"：在原汇总行上方叠加红色万元浮层，原始数字不做任何修改（推荐）
    // "inline" ：保留旧做法，在数字后面追加蓝色 (xx.xx万) 小标签
    wanDisplayMode: "overlay",
    summarySelector: ".statistics-info",  // 承载"查询结果：合计金额…"的容器
    wanColor: "#e02020",
    wanFontSize: 15,
    wanDecimals: 4,                       // 万元小数位，4 位 ≈ 精确到元
    wanBold: true,
    unitAuto: true                        // 超过 1 亿自动切换成「亿元」
};

// =====================================================
// === 1.2 用户设置（由 popup 面板写入 chrome.storage.sync） ===
// =====================================================
const SETTINGS_KEY = "plugin_settings_v2";

const SETTINGS_DEFAULTS = {
    /* 万元显示 */
    wanDisplayMode: "overlay",   // overlay | inline | off
    amountToWan: true,           // 合计金额转万元
    taxToWan: true,              // 合计税额转万元
    wanDecimals: 4,
    wanColor: "#e02020",
    wanFontSize: 15,
    wanBold: true,
    unitAuto: true,              // 超过 1 亿自动用「亿元」
    /* 高亮 */
    thresholdOn: true,
    highlightThreshold: 300000,
    typeHighlight: true,
    /* 定时刷新 */
    autoRefresh: false,
    refreshSeconds: 60,
    refreshScope: "login",       // login（仅登录页）| query（仅发票查询页）| all
    restoreQuery: true,
    refreshBadge: true
};

let S = Object.assign({}, SETTINGS_DEFAULTS);

// 把用户设置映射到运行时 config / textConfig
function applySettings() {
    config.wanDisplayMode = S.wanDisplayMode === "off" ? "off" : (S.wanDisplayMode === "inline" ? "inline" : "overlay");
    config.wanColor = S.wanColor || "#e02020";
    config.wanFontSize = Number(S.wanFontSize) || 15;
    config.wanDecimals = Number.isFinite(Number(S.wanDecimals)) ? Number(S.wanDecimals) : 4;
    config.wanBold = !!S.wanBold;
    config.amountToWan = !!S.amountToWan;
    config.taxToWan = !!S.taxToWan;
    config.unitAuto = S.unitAuto !== false;
    config.highlightThreshold = S.thresholdOn ? (Number(S.highlightThreshold) || 0) : Infinity;
    config.typeHighlight = !!S.typeHighlight;

    // 兼容旧版本存下的 "query"：统一归到 login（定时刷新只发生在登录页）
    if (S.refreshScope !== "all") S.refreshScope = "login";
}

const textConfig = {
    selector: ".t-table__ellipsis.t-text-ellipsis", 
    targetText: "数电发票（增值税专用发票）", 
    highlightColor: "#ff4d4f"
};

const quickNavConfig = {
    // 左侧税务助手显示白名单：协议 + 域名 + 端口完全一致时才注入。
    // etax / dppt / tpass 共用同一个侧边栏；登录区仅在登录页可填充。
    menuOrigins: [
        "https://etax.hubei.chinatax.gov.cn:8443",
        "https://dppt.hubei.chinatax.gov.cn:8443",
        "https://tpass.hubei.chinatax.gov.cn:8443"
    ],
    links: [
        { name: "🔑 自动填充", url: "javascript:void(0)", onclick: (e) => handleAutoLogin(e), target: "_self" },
        { name: "🔄 身份切换", url: "https://tpass.hubei.chinatax.gov.cn:8443/#/identitySwitch/agent" },
        { name: "📋 复制开票", url: "https://dppt.hubei.chinatax.gov.cn:8443/blue-invoice-makeout/invoice-copy" },
        { name: "🟦 蓝字开具", url: "https://dppt.hubei.chinatax.gov.cn:8443/blue-invoice-makeout/invoice-makeout" },
        { name: "🟥 红字开具", url: "https://dppt.hubei.chinatax.gov.cn:8443/red-invoice/info-confirm?id=2" },
        { name: "🔍 全量查询", url: "https://dppt.hubei.chinatax.gov.cn:8443/invoice-query/invoice-query" },
        { name: "ℹ️ 信息查询", url: "https://etax.hubei.chinatax.gov.cn:8443/szzh/zhcx/nsrxxcx" },
        { name: "⚠️ 未申报查询", url: "https://etax.hubei.chinatax.gov.cn:8443/xxbg/view/zhsffw/#/sszyfwjgplsb/plsbzh" },
        { name: "🧹 重置账号", url: "javascript:void(0)", onclick: (e) => resetCredentials(), target: "_self" }
    ]
};

const state = { 
    lastTotalText: "",
    selectedYear: new Date().getFullYear(),
    isRunning: false,
    isPrompting: false 
};

// =====================================================
// === 1.5 快捷菜单显示范围判定（只算一次） ===
// =====================================================
const MENU_ID = "plugin-quick-nav";

// 把配置里的地址归一化成 "协议//host[:端口]"，与本页 location 对齐比较
function normalizeOrigin(raw) {
    try {
        const u = new URL(raw);
        return u.protocol + "//" + u.host;
    } catch (e) {
        return String(raw || "").trim().replace(/\/+$/, "").toLowerCase();
    }
}

const MENU_ALLOWED = (() => {
    const self = location.protocol + "//" + location.host;
    return (quickNavConfig.menuOrigins || []).some(item => normalizeOrigin(item) === self);
})();

// =====================================================
// === 2. 核心功能：底层注入与跨域存储 ===
// =====================================================

// 解决日期回弹的强力填充逻辑
function nativeFill(input, value, options = {}) {
    if (!input || value === undefined || value === null || value === "") return;
    try {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // 日期输入需要回车让组件确认；登录表单逐项填充时不能回车，否则首项就会触发提交。
        if (options.pressEnter !== false) {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        }
    } catch (e) {}
}

// =====================================================
// === 2.1 登录助手：悬浮账号卡 + 跨域填充 ===
// =====================================================
// 登录表单不再创建独立窗口，而是嵌入左侧 plugin-quick-nav 侧边栏。
const LOGIN_PANEL_ID = MENU_ID;

const LOGIN_FIELD_SELECTORS = {
    code: [
        'input[placeholder*="信用代码"]',
        'input[placeholder*="统一社会信用代码"]',
        'input[placeholder*="纳税人识别号"]',
        'input[name*="credit"]',
        'input[name*="taxNo"]'
    ],
    num: [
        'input[placeholder*="手机"]',
        'input[placeholder*="证件"]',
        'input[placeholder*="身份证"]',
        'input[placeholder*="号码"]',
        'input[placeholder*="用户名"]',
        'input[name*="phone"]',
        'input[name*="mobile"]',
        'input[name*="idCard"]',
        'input[name*="certNo"]'
    ],
    pwd: ['input[type="password"]']
};

function isLoginPage() {
    const host = location.hostname.toLowerCase();
    if (host === "tpass.hubei.chinatax.gov.cn") {
        return /#\/login(?:\?|\/|$)/i.test(location.hash || "")
            || /^\/login/i.test(location.pathname);
    }
    return host === "etax.hubei.chinatax.gov.cn"
        && /^\/loginb(?:\/|$)/i.test(location.pathname);
}

function getSavedCredentials(callback) {
    try {
        chrome.storage.local.get([config.storageKey], (result) => {
            if (chrome.runtime.lastError) {
                showToast("⚠ 读取账号失败，请检查扩展权限", window.innerWidth / 2, 140, "#ff4d4f");
                callback(null);
                return;
            }
            callback((result && result[config.storageKey]) || null);
        });
    } catch (e) {
        callback(null);
        showToast("⚠ 存储不可用，请检查扩展权限", window.innerWidth / 2, 140, "#ff4d4f");
    }
}

function saveCredentials(creds, callback) {
    try {
        chrome.storage.local.set({ [config.storageKey]: creds }, () => {
            // chrome.storage 的错误是异步通过 runtime.lastError 返回的；
            // 不检查会把写入失败误报成“已保存”。
            if (chrome.runtime.lastError) {
                showToast("⚠ 保存失败，请检查扩展权限", window.innerWidth / 2, 140, "#ff4d4f");
                callback && callback(false);
                return;
            }
            callback && callback(true);
        });
    } catch (e) {
        showToast("⚠ 保存失败，请检查扩展权限", window.innerWidth / 2, 140, "#ff4d4f");
        callback && callback(false);
    }
}

function updateLoginPanelFields(creds) {
    const panel = document.getElementById(LOGIN_PANEL_ID);
    if (!panel) return;
    const code = panel.querySelector('[data-plugin-login-field="code"]');
    const num = panel.querySelector('[data-plugin-login-field="num"]');
    const pwd = panel.querySelector('[data-plugin-login-field="pwd"]');
    if (code) code.value = creds && creds.code || "";
    if (num) num.value = creds && creds.num || "";
    if (pwd) pwd.value = creds && creds.pwd || "";
}

function resetCredentials() {
    if (!confirm("确定要清空已保存的账号吗？（所有税务页面都将重置）")) return;
    try {
        chrome.storage.local.remove(config.storageKey, () => {
            if (chrome.runtime.lastError) {
                setLoginPanelStatus("清空失败，请检查扩展权限", "error");
                showToast("⚠ 清空失败，请检查扩展权限", window.innerWidth / 2, 140, "#ff4d4f");
                return;
            }
            updateLoginPanelFields(null);
            setLoginPanelStatus("账号已清空", "ok");
            showToast("✓ 账号信息已清空", window.innerWidth / 2, 140, "#52c41a");
        });
    } catch (e) {
        showToast("⚠ 清空失败，请检查扩展权限", window.innerWidth / 2, 140, "#ff4d4f");
    }
}

// 找「密码登录」标签页：优先精确匹配，避免误点"忘记密码""注册"等链接
function findPasswordTab() {
    const cands = Array.from(document.querySelectorAll(
        'span, button, a, .t-tabs__item, .t-tabs__nav-item, .el-tabs__item, .ant-tabs-tab, .arco-tabs-tab, [role="tab"]'
    ));
    const bad = /忘记|找回|注册|设置密码|修改密码/;
    const clean = (el) => {
        const t = (el.innerText || el.textContent || "").replace(/\s+/g, "");
        if (!t || t.length > 12 || bad.test(t)) return "";
        return t;
    };
    return cands.find(el => clean(el) === "密码登录")
        || cands.find(el => clean(el).includes("密码"))
        || null;
}

function isUsableLoginInput(input) {
    if (!input || input.disabled || input.readOnly) return false;
    if (input.closest && input.closest("#" + LOGIN_PANEL_ID)) return false;
    try {
        const style = window.getComputedStyle(input);
        if (style.display === "none" || style.visibility === "hidden") return false;
        return input.getClientRects().length > 0;
    } catch (e) {
        return true;
    }
}

function findLoginInput(selectors) {
    for (const selector of selectors) {
        const inputs = document.querySelectorAll(selector);
        for (const input of inputs) {
            if (isUsableLoginInput(input)) return input;
        }
    }
    return null;
}

function fillLoginForm(creds, callback) {
    const tab = findPasswordTab();
    if (tab) tab.click();

    let attempts = 0;
    const tick = () => {
        attempts += 1;
        const code = findLoginInput(LOGIN_FIELD_SELECTORS.code);
        const num = findLoginInput(LOGIN_FIELD_SELECTORS.num);
        const pwd = findLoginInput(LOGIN_FIELD_SELECTORS.pwd);
        let filled = 0;

        const expected = [creds.code, creds.num, creds.pwd].filter(Boolean).length;
        if (code && creds.code) { nativeFill(code, creds.code, { pressEnter: false }); filled += 1; }
        if (num && creds.num) { nativeFill(num, creds.num, { pressEnter: false }); filled += 1; }
        if (pwd && creds.pwd) { nativeFill(pwd, creds.pwd, { pressEnter: false }); filled += 1; }

        // tpass 是 SPA，切换「密码登录」后表单可能晚于点击 400ms 才出现，做有限重试。
        // 只有保存的三项都真正找到并填入，才提示成功，避免部分填错也被当成完成。
        if (expected > 0 && filled === expected) {
            callback && callback(true, attempts);
            return;
        }
        if (attempts < 12) {
            setTimeout(tick, 250);
        } else {
            callback && callback(false, attempts);
        }
    };
    setTimeout(tick, 0);
}

function setLoginPanelStatus(text, kind = "muted") {
    const status = document.getElementById("plugin-login-status");
    if (!status) return;
    const colors = {
        muted: "#8c8c8c",
        ok: "#389e0d",
        error: "#cf1322",
        pending: "#0958d9"
    };
    status.textContent = text;
    status.style.color = colors[kind] || colors.muted;
}

function ensureQuickNavStyle() {
    if (document.getElementById("plugin-quick-nav-style")) return;
    const style = document.createElement("style");
    style.id = "plugin-quick-nav-style";
    style.textContent = `
        #${MENU_ID} {
            position: fixed; left: 0; top: 12px; width: 14px;
            max-height: calc(100vh - 24px); z-index: 2147483647;
            color: #1f2937; background: transparent; overflow: hidden;
            font: 12px/1.45 "Microsoft YaHei", "PingFang SC", sans-serif;
            transition: width .22s ease, box-shadow .22s ease;
        }
        #${MENU_ID} * { box-sizing: border-box; }
        #${MENU_ID}.is-open {
            width: min(326px, calc(100vw - 20px)); background: #fff;
            border: 1px solid #dbe7f5; border-left: 0; border-radius: 0 14px 14px 0;
            box-shadow: 8px 8px 28px rgba(22, 93, 255, .16), 0 2px 8px rgba(0, 0, 0, .08);
        }
        #${MENU_ID} .plugin-nav-rail {
            width: 14px; min-height: 112px; padding: 12px 2px 10px;
            display: flex; align-items: center; justify-content: center;
            writing-mode: vertical-rl; text-orientation: upright; letter-spacing: 3px;
            background: linear-gradient(180deg, #0f6cff, #2f8cff); color: #fff;
            border-radius: 0 10px 10px 0; box-shadow: 4px 2px 14px rgba(15, 108, 255, .24);
            font-size: 11px; font-weight: 700; cursor: pointer; user-select: none;
        }
        #${MENU_ID}.is-open .plugin-nav-rail { display: none; }
        #${MENU_ID} .plugin-nav-content {
            display: none; width: 100%; max-height: calc(100vh - 24px);
            overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin;
        }
        #${MENU_ID}.is-open .plugin-nav-content { display: block; }
        #${MENU_ID} button, #${MENU_ID} input, #${MENU_ID} select { font: inherit; }
        #${MENU_ID} .plugin-nav-head {
            position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 8px;
            padding: 10px 11px; background: linear-gradient(135deg, #0f6cff, #2f8cff); color: #fff;
            user-select: none;
        }
        #${MENU_ID} .plugin-nav-mark {
            width: 28px; height: 28px; flex: 0 0 auto; display: grid; place-items: center;
            border-radius: 9px; background: rgba(255,255,255,.18); font-size: 15px;
        }
        #${MENU_ID} .plugin-nav-title { font-size: 13px; font-weight: 700; letter-spacing: .2px; }
        #${MENU_ID} .plugin-nav-sub { font-size: 9px; opacity: .82; margin-top: 1px; }
        #${MENU_ID} .plugin-nav-head-tools { margin-left: auto; display: flex; gap: 5px; }
        #${MENU_ID} .plugin-nav-tool {
            width: 26px; height: 26px; padding: 0; border: 0; border-radius: 8px;
            background: rgba(255,255,255,.16); color: #fff; cursor: pointer; line-height: 1;
        }
        #${MENU_ID} .plugin-nav-tool:hover, #${MENU_ID} .plugin-nav-tool[aria-pressed="true"] {
            background: rgba(255,255,255,.3);
        }
        #${MENU_ID} .plugin-nav-context {
            margin: 10px 11px 0; padding: 8px 10px; border-radius: 9px;
            background: #eef6ff; border: 1px solid #d6e9ff; color: #24558f;
            font-size: 10px; line-height: 1.45;
        }
        #${MENU_ID} .plugin-nav-context.is-login {
            background: #effaf1; border-color: #ccebd2; color: #237434;
        }
        #${MENU_ID} .plugin-nav-section { padding: 10px 11px 12px; }
        #${MENU_ID} .plugin-nav-section + .plugin-nav-section { border-top: 1px solid #edf2f8; }
        #${MENU_ID} .plugin-nav-section-title {
            display: flex; align-items: center; gap: 7px; margin-bottom: 8px;
            color: #344054; font-size: 11px; font-weight: 700;
        }
        #${MENU_ID} .plugin-nav-section-title small {
            margin-left: auto; color: #8b97a8; font-size: 9px; font-weight: 400;
        }
        #${MENU_ID} .plugin-login-label {
            display: block; margin: 7px 0 4px; color: #4b5563; font-size: 10px; font-weight: 700;
        }
        #${MENU_ID} .plugin-login-input {
            width: 100%; height: 32px; border: 1px solid #d7e2f0; border-radius: 8px;
            padding: 0 9px; outline: none; color: #111827; background: #fff;
        }
        #${MENU_ID} .plugin-login-input:focus {
            border-color: #2f8cff; box-shadow: 0 0 0 3px rgba(47,140,255,.12);
        }
        #${MENU_ID} .plugin-login-password-row { display: flex; gap: 6px; align-items: center; }
        #${MENU_ID} .plugin-login-eye {
            height: 32px; flex: 0 0 48px; border: 1px solid #d7e2f0; border-radius: 8px;
            background: #f7faff; color: #2563eb; cursor: pointer;
        }
        #${MENU_ID} .plugin-login-actions { display: flex; gap: 7px; margin-top: 10px; }
        #${MENU_ID} .plugin-login-btn {
            flex: 1; height: 32px; border-radius: 8px; cursor: pointer;
            font-size: 10px; font-weight: 700;
        }
        #${MENU_ID} .plugin-login-btn.primary { border: 1px solid #0f6cff; background: #0f6cff; color: #fff; }
        #${MENU_ID} .plugin-login-btn.primary:hover { background: #0958d9; }
        #${MENU_ID} .plugin-login-btn.secondary { border: 1px solid #b8d0ef; background: #f7faff; color: #0f5ecf; }
        #${MENU_ID} .plugin-login-btn:disabled { cursor: not-allowed; opacity: .45; }
        #${MENU_ID} .plugin-login-clear {
            border: 0; background: transparent; color: #cf1322; padding: 5px 1px;
            cursor: pointer; white-space: nowrap; font-size: 10px;
        }
        #${MENU_ID} .plugin-login-status { min-height: 17px; margin-top: 7px; color: #8c8c8c; font-size: 10px; }
        #${MENU_ID} .plugin-login-privacy { margin-top: 4px; color: #98a2b3; font-size: 9px; line-height: 1.5; }
        #${MENU_ID} .plugin-nav-link {
            display: flex; align-items: center; min-height: 31px; padding: 7px 9px;
            color: #475467; text-decoration: none; border: 1px solid transparent;
            border-radius: 7px; white-space: nowrap; cursor: pointer;
        }
        #${MENU_ID} .plugin-nav-link:hover { background: #f5f9ff; border-color: #e1ecfb; color: #0f5ecf; }
        #${MENU_ID} .plugin-nav-link.is-danger { color: #cf1322; }
        #${MENU_ID} .plugin-nav-date { padding: 0 11px 12px; }
        #${MENU_ID} .plugin-nav-help {
            margin: 7px 0 0; color: #98a2b3; font-size: 9px; line-height: 1.5;
        }
        #${MENU_ID} .plugin-nav-close-note {
            padding: 7px 11px 10px; color: #b0b8c4; font-size: 9px; text-align: center;
        }
        #${MENU_ID} .dynamic-date-btn { width: 100%; }
    `;
    (document.head || document.documentElement).appendChild(style);
}

function readPanelCredentials() {
    const panel = document.getElementById(LOGIN_PANEL_ID);
    if (!panel) return null;
    const code = panel.querySelector('[data-plugin-login-field="code"]');
    const num = panel.querySelector('[data-plugin-login-field="num"]');
    const pwd = panel.querySelector('[data-plugin-login-field="pwd"]');
    if (!code || !num || !pwd) return null;
    return {
        code: (code.value || "").trim(),
        num: (num.value || "").trim(),
        pwd: pwd.value || ""
    };
}

function submitPanelLogin(save) {
    const creds = readPanelCredentials();
    if (!creds || !creds.code || !creds.num || !creds.pwd) {
        setLoginPanelStatus("请完整填写信用代码、号码和密码", "error");
        return;
    }

    const loginPage = isLoginPage();
    if (!save && !loginPage) {
        setLoginPanelStatus("当前不是登录页；请进入登录页后再填充", "error");
        showToast("请先进入登录页，再点「仅填充」", window.innerWidth / 2, 120, "#fa8c16");
        return;
    }

    const run = () => {
        setLoginPanelStatus("正在定位登录表单并填充…", "pending");
        fillLoginForm(creds, (ok, attempts) => {
            if (ok) {
                setLoginPanelStatus(save ? "已保存并填入登录表单" : "已填入登录表单", "ok");
                showToast("✓ 登录信息已填入", window.innerWidth / 2, 120, "#52c41a");
            } else {
                setLoginPanelStatus(`未完整填充登录表单（已尝试 ${attempts} 次）`, "error");
                showToast("⚠ 未完整找到密码登录表单，请先切到「密码登录」", window.innerWidth / 2, 120, "#ff4d4f");
            }
        });
    };

    if (save) {
        saveCredentials(creds, (ok) => {
            if (ok === false) return;
            if (!loginPage) {
                setLoginPanelStatus("账号已保存；进入登录页后可一键填充", "ok");
                showToast("✓ 账号已保存，进入登录页后可填充", window.innerWidth / 2, 120, "#52c41a");
                return;
            }
            setLoginPanelStatus("账号已保存，正在填充…", "pending");
            run();
        });
    } else {
        run();
    }
}

function hasCompleteCredentials(creds) {
    return !!(creds && creds.code && creds.num && creds.pwd);
}

function setSidebarOpen(menu, open) {
    if (!menu) return;
    menu.classList.toggle("is-open", !!open);
    menu.setAttribute("aria-expanded", String(!!open));
}

function openLoginSidebar(focusCode) {
    createQuickNavMenu();
    const menu = document.getElementById(LOGIN_PANEL_ID);
    if (!menu) return null;
    syncSidebarPageState(menu);
    setSidebarOpen(menu, true);
    if (focusCode) {
        setTimeout(() => {
            const code = menu.querySelector('[data-plugin-login-field="code"]');
            if (code) {
                code.focus();
                code.select();
                code.scrollIntoView({ block: "nearest" });
            }
        }, 40);
    }
    return menu;
}

function syncSidebarPageState(menu) {
    if (!menu) return;
    const loginPage = isLoginPage();
    const hint = menu.querySelector("#plugin-login-page-hint");
    if (hint) {
        hint.classList.toggle("is-login", loginPage);
        if (loginPage) {
            hint.textContent = "当前在登录页：填写后可直接保存并填充。";
        } else if (/^dppt\./i.test(location.hostname)) {
            hint.textContent = "当前在发票业务页：账号可保存，进入登录页后再填充。";
        } else {
            hint.textContent = "当前不是登录页：账号可保存，进入登录页后再填充。";
        }
    }

    const saveFill = menu.querySelector('[data-plugin-login-action="save-fill"]');
    if (saveFill) {
        saveFill.textContent = loginPage ? "保存并填充" : "仅保存账号";
        saveFill.title = loginPage ? "保存账号并填入登录表单" : "只保存账号，不执行填充";
    }
    const fill = menu.querySelector('[data-plugin-login-action="fill"]');
    if (fill) {
        fill.disabled = !loginPage;
        fill.title = loginPage ? "使用已保存的账号填充登录表单" : "进入登录页后才能填充";
    }
    menu.dataset.loginPage = loginPage ? "1" : "0";
}

function handleAutoLogin() {
    getSavedCredentials((creds) => {
        if (!hasCompleteCredentials(creds)) {
            openLoginSidebar(true);
            setLoginPanelStatus("请先在左侧助手完整填写信用代码、号码和密码", "error");
            showToast("请先在左侧助手填写完整账号", window.innerWidth / 2, 120, "#fa8c16");
            return;
        }
        if (!isLoginPage()) {
            openLoginSidebar(false);
            setLoginPanelStatus("账号已保存；进入登录页后再执行填充", "ok");
            showToast("当前不是登录页，请先进入登录页", window.innerWidth / 2, 120, "#fa8c16");
            return;
        }
        fillLoginForm(creds, (ok) => {
            showToast(ok ? "✓ 登录信息已填入" : "⚠ 当前页面未完整找到登录表单",
                window.innerWidth / 2, 120, ok ? "#52c41a" : "#ff4d4f");
        });
    });
}

function fillDateAndSearch(start, end) {
    const sIn = document.querySelector('input[placeholder="开票日期起"]');
    const eIn = document.querySelector('input[placeholder="开票日期止"]');
    if (!sIn || !eIn) {
        showToast("⚠ 当前页面没有「开票日期」条件，请先进入发票查询", window.innerWidth / 2, 140, "#ff4d4f");
        return;
    }

    [[sIn, start], [eIn, end]].forEach(([input, v]) => {
        nativeFill(input, v);
        input.blur();
    });

    setTimeout(() => {
        // 日期没被组件接受就别乱点查询，避免查成默认区间
        const norm = (s) => String(s || "").replace(/[^\d]/g, "");
        if (norm(sIn.value) !== norm(start) || norm(eIn.value) !== norm(end)) {
            showToast("⚠ 日期未被页面接受，请手动选择一次", window.innerWidth / 2, 140, "#ff4d4f");
            return;
        }
        const btns = Array.from(document.querySelectorAll("button"));
        const sBtn = btns.find(b => (b.textContent || "").replace(/\s+/g, "") === "查询")
            || btns.find(b => /查询/.test(b.textContent || ""));
        if (sBtn) sBtn.click();
    }, 800);
}

// =====================================================
// === 2.5 万元显示：汇总行上方红色浮层（新增） ===
// =====================================================
const WAN_ROW_CLASS = "plugin-wan-overlay";

function fmtThousands(n, d) {
    const neg = n < 0;
    const parts = Math.abs(n).toFixed(d).split(".");
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + intPart + (parts[1] ? "." + parts[1] : "");
}

// 单位自适应：≥1 亿时改用「亿元」
function pickUnit(num) {
    if (config.unitAuto !== false && Math.abs(num) >= 1e8) {
        return { div: 1e8, unit: "亿元", decimals: config.wanDecimals };
    }
    return { div: 1e4, unit: "万元", decimals: config.wanDecimals };
}

// 生成 "17.8766 万元"，数值与单位均标红，数值可点击复制
function wanBadgeHtml(num, rawStr) {
    const numStyle = `font-size:${config.wanFontSize}px;color:${config.wanColor};${config.wanBold ? "font-weight:700;" : ""}`;
    const unitStyle = `color:${config.wanColor};${config.wanBold ? "font-weight:600;" : ""}margin-left:1px;`;
    const u = pickUnit(num);
    const val = num === 0 ? "0" : fmtThousands(num / u.div, u.decimals);
    const tip = `原始 ${fmtThousands(num, 2)} 元 · 点击复制`;
    return `<span class="plugin-wan-num" data-copy="${rawStr}" title="${tip}" style="${numStyle}cursor:pointer;">${val}</span>` +
           `<span class="plugin-wan-unit" style="${unitStyle}">${u.unit}</span>`;
}

// 从汇总文本里取 "合计金额：xxx元" / "合计税额：xxx元"
function parseSummaryItem(text, label) {
    const re = new RegExp("合\\s*计\\s*" + label + "\\s*[：:]\\s*([\\d,]+(?:\\.\\d+)?)\\s*元");
    const m = text.match(re);
    if (!m) return null;
    const v = parseFloat(m[1].replace(/,/g, ""));
    if (!isFinite(v)) return null;
    return { value: v, raw: m[1].replace(/,/g, "") };
}

function buildWanHtml(text) {
    const items = [];
    const amt = parseSummaryItem(text, "金\\s*额");
    if (amt && config.amountToWan !== false) items.push("合计金额：" + wanBadgeHtml(amt.value, amt.raw));
    const tax = parseSummaryItem(text, "税\\s*额");
    if (tax && config.taxToWan !== false) items.push("合计税额：" + wanBadgeHtml(tax.value, tax.raw));
    return items.length ? items.join("　") : null;
}

// 核心：原始汇总节点零改动，只在它的父容器里追加一个绝对定位浮层
function renderWanOverlay() {
    if (config.wanDisplayMode === "off") { clearWanOverlay(); return; }
    document.querySelectorAll(config.summarySelector).forEach(el => {
        if (el.classList.contains(WAN_ROW_CLASS)) return;

        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || !/合\s*计\s*(金\s*额|税\s*额)/.test(text)) return;

        const html = buildWanHtml(text);
        if (!html) return;

        const box = el.parentElement;
        if (!box) return;

        // 定位参照：容器需要非 static
        if (getComputedStyle(box).position === "static") box.style.position = "relative";

        let row = null;
        for (const c of box.children) {
            if (c.classList.contains(WAN_ROW_CLASS)) { row = c; break; }
        }

        if (!row) {
            row = document.createElement("div");
            row.className = WAN_ROW_CLASS;
            row.style.cssText = "position:absolute;right:0;bottom:100%;white-space:nowrap;" +
                "line-height:1.5;z-index:5;";
            // 点击数值复制原始金额
            row.addEventListener("click", (e) => {
                const t = e.target.closest("[data-copy]");
                if (t) copyToClipboard(t.dataset.copy, e);
            });
            box.appendChild(row);
            row.dataset.src = "";
        }

        // 文本变了才重绘，避免重新查询时闪烁
        if (row.dataset.src !== text) {
            row.innerHTML = html;
            row.dataset.src = text;
        }
    });
}

// 切回 inline 模式时清掉浮层
function clearWanOverlay() {
    document.querySelectorAll("." + WAN_ROW_CLASS).forEach(el => el.remove());
}

// =====================================================
// === 3. UI 界面逻辑 (保留所有原生偏移算法) ===
// =====================================================

// 通用浮动提示（复制成功、参数缺失等）
function showToast(text, x, y, color = "#52c41a") {
    if (!document.body) return;
    const tip = document.createElement("div");
    tip.innerText = text;
    const px = Number.isFinite(x) ? x : window.innerWidth / 2;
    const py = Number.isFinite(y) ? y : window.innerHeight / 2;
    tip.style.cssText = `position: fixed; left: ${px}px; top: ${py - 30}px; transform: translateX(-50%); background: ${color}; color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; z-index: 2147483647; pointer-events: none; animation: tipFadeUp 0.8s ease-out forwards; white-space: nowrap; box-shadow: 0 4px 10px rgba(0,0,0,0.15);`;
    if (!document.getElementById('plugin-anim-style')) {
        const style = document.createElement('style');
        style.id = 'plugin-anim-style';
        style.innerHTML = `@keyframes tipFadeUp { 0% { opacity: 0; transform: translate(-50%, 5px); } 20% { opacity: 1; transform: translate(-50%, 0); } 100% { opacity: 0; transform: translate(-50%, -10px); } }`;
        document.head.appendChild(style);
    }
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), 800);
}

function copyToClipboard(text, event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    const x = event ? event.clientX : window.innerWidth / 2;
    const y = event ? event.clientY : window.innerHeight / 2;

    const fallback = () => {
        // clipboard API 在页面失焦 / 无权限时会 reject，用 execCommand 兜底
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            ta.remove();
            showToast(ok ? "✓ 已复制" : "✗ 复制失败", x, y, ok ? "#52c41a" : "#ff4d4f");
        } catch (err) {
            showToast("✗ 复制失败", x, y, "#ff4d4f");
        }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => showToast("✓ 已复制", x, y), fallback);
    } else {
        fallback();
    }
}

function updateDateButtons(container) {
    container.querySelectorAll('.dynamic-date-btn').forEach(b => b.remove());
    const year = state.selectedYear;
    const createBtn = (txt, start, end, color = "#52c41a") => {
        const b = document.createElement('button');
        b.className = 'dynamic-date-btn';
        b.textContent = txt;
        b.style.cssText = `width: 100%; padding: 5px 0; margin-top: 5px; cursor: pointer; border: 1px solid ${color}; background: white; color: ${color}; border-radius: 6px; font-size: 10px; font-weight: 600; transition: all 0.2s;`;
        if (txt.includes("全年")) { b.style.background = "#fa8c16"; b.style.color = "white"; b.style.borderColor = "#fa8c16"; }
        b.onclick = () => fillDateAndSearch(start, end);
        container.appendChild(b);
    };
    createBtn(`📅 ${year}全年`, `${year}-01-01`, `${year}-12-31`, "#fa8c16");
    const qs = [{n:"一季度", s:`${year}-01-01`, e:`${year}-03-31`}, {n:"二季度", s:`${year}-04-01`, e:`${year}-06-30`}, {n:"三季度", s:`${year}-07-01`, e:`${year}-09-30`}, {n:"四季度", s:`${year}-10-01`, e:`${year}-12-31`}].forEach(q => createBtn(q.n, q.s, q.e, "#52c41a"));
}

function createQuickNavMenu() {
    // 白名单覆盖 etax / dppt / tpass：所有税务业务页共用同一个左侧侧边助手。
    if (!MENU_ALLOWED) {
        const stale = document.getElementById(MENU_ID);
        if (stale) stale.remove();
        return;
    }
    if (!document.body) return;

    const existing = document.getElementById(MENU_ID);
    if (existing) {
        syncSidebarPageState(existing);
        return;
    }

    ensureQuickNavStyle();
    const menu = document.createElement("aside");
    menu.id = MENU_ID;
    menu.setAttribute("role", "complementary");
    menu.setAttribute("aria-label", "TaxTally 税务侧边助手");
    menu.setAttribute("aria-expanded", "false");
    menu.innerHTML = `
        <div class="plugin-nav-rail" role="button" tabindex="0" title="展开税务助手" aria-label="展开税务助手">税务助手</div>
        <div class="plugin-nav-content">
            <div class="plugin-nav-head">
                <div class="plugin-nav-mark">税</div>
                <div>
                    <div class="plugin-nav-title">税务侧边助手</div>
                    <div class="plugin-nav-sub">登录账号 · 快捷办税 · 日期工具</div>
                </div>
                <div class="plugin-nav-head-tools">
                    <button class="plugin-nav-tool" type="button" data-nav-action="pin" title="固定展开" aria-label="固定展开" aria-pressed="false">📌</button>
                    <button class="plugin-nav-tool" type="button" data-nav-action="close" title="收起" aria-label="收起侧边助手">×</button>
                </div>
            </div>
            <div class="plugin-nav-context" id="plugin-login-page-hint">正在识别当前页面…</div>

            <section class="plugin-nav-section">
                <div class="plugin-nav-section-title">🔑 登录助手 <small>仅保存在本机</small></div>
                <label class="plugin-login-label" for="plugin-login-code">统一社会信用代码</label>
                <input id="plugin-login-code" class="plugin-login-input" data-plugin-login-field="code" autocomplete="username" placeholder="请输入信用代码">
                <label class="plugin-login-label" for="plugin-login-num">手机号 / 证件号码</label>
                <input id="plugin-login-num" class="plugin-login-input" data-plugin-login-field="num" autocomplete="username" placeholder="请输入手机号或证件号码">
                <label class="plugin-login-label" for="plugin-login-pwd">登录密码</label>
                <div class="plugin-login-password-row">
                    <input id="plugin-login-pwd" class="plugin-login-input" data-plugin-login-field="pwd" type="password" autocomplete="current-password" placeholder="请输入登录密码">
                    <button class="plugin-login-eye" type="button" data-plugin-login-action="toggle-password">显示</button>
                </div>
                <div class="plugin-login-actions">
                    <button class="plugin-login-btn primary" type="button" data-plugin-login-action="save-fill">保存并填充</button>
                    <button class="plugin-login-btn secondary" type="button" data-plugin-login-action="fill">仅填充</button>
                    <button class="plugin-login-clear" type="button" data-plugin-login-action="clear">清空</button>
                </div>
                <div class="plugin-login-status" id="plugin-login-status" role="status">正在读取本机账号…</div>
                <div class="plugin-login-privacy">账号只写入 chrome.storage.local；不联网，不上传到税务页面以外的位置。</div>
            </section>

            <section class="plugin-nav-section">
                <div class="plugin-nav-section-title">⚡ 快捷办税 <small>常用入口</small></div>
                <div id="plugin-quick-links"></div>
            </section>

            <section class="plugin-nav-section">
                <div class="plugin-nav-section-title">📅 日期快捷 <small>发票查询页</small></div>
                <div id="plugin-date-box"></div>
            </section>
            <div class="plugin-nav-close-note">鼠标移出自动收起；点 📌 可固定</div>
        </div>
    `;
    document.body.appendChild(menu);

    const rail = menu.querySelector(".plugin-nav-rail");
    const pinBtn = menu.querySelector('[data-nav-action="pin"]');
    const closeBtn = menu.querySelector('[data-nav-action="close"]');
    let closeTimer = null;
    const isPinned = () => pinBtn.getAttribute("aria-pressed") === "true";

    const scheduleClose = () => {
        if (closeTimer) clearTimeout(closeTimer);
        closeTimer = setTimeout(() => {
            if (isPinned() || menu.matches(":hover")) return;
            if (menu.contains(document.activeElement)) return;
            setSidebarOpen(menu, false);
        }, 260);
    };

    menu.addEventListener("mouseenter", () => {
        if (closeTimer) clearTimeout(closeTimer);
        setSidebarOpen(menu, true);
    });
    menu.addEventListener("mouseleave", scheduleClose);
    menu.addEventListener("focusin", (e) => {
        setSidebarOpen(menu, true);
        if (e.target === rail) setTimeout(() => pinBtn.focus(), 0);
    });
    menu.addEventListener("focusout", (e) => {
        if (menu.contains(e.relatedTarget)) return;
        scheduleClose();
    });

    rail.addEventListener("click", () => setSidebarOpen(menu, true));
    rail.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        setSidebarOpen(menu, true);
        pinBtn.focus();
    });
    pinBtn.addEventListener("click", () => {
        const pinned = !isPinned();
        pinBtn.setAttribute("aria-pressed", String(pinned));
        pinBtn.title = pinned ? "取消固定" : "固定展开";
        pinBtn.setAttribute("aria-label", pinned ? "取消固定" : "固定展开");
        setSidebarOpen(menu, true);
    });
    closeBtn.addEventListener("click", () => {
        pinBtn.setAttribute("aria-pressed", "false");
        if (menu.contains(document.activeElement)) document.activeElement.blur();
        setSidebarOpen(menu, false);
    });

    const linkBox = menu.querySelector("#plugin-quick-links");
    quickNavConfig.links.forEach(link => {
        const a = document.createElement("a");
        a.className = "plugin-nav-link" + (link.name.includes("重置") ? " is-danger" : "");
        a.innerText = link.name;
        a.href = link.url;
        a.target = link.target || "_blank";
        a.rel = "noopener noreferrer";
        if (link.onclick) {
            // 阻止 javascript: 伪协议跳转，避免被页面 CSP 拦截或触发额外导航
            a.onclick = (e) => { e.preventDefault(); link.onclick(e); };
        }
        linkBox.appendChild(a);
    });

    const dBox = menu.querySelector("#plugin-date-box");
    const d = new Date();
    const fmt = (date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    const s12 = fmt(new Date(d.getFullYear()-1, d.getMonth(), d.getDate()+2));
    const e12 = fmt(new Date(d.getFullYear(), d.getMonth(), d.getDate()+1));

    const fixB = document.createElement("button");
    fixB.type = "button";
    fixB.textContent = "📅 近12个月";
    fixB.style.cssText = `width: 100%; padding: 6px 0; margin-bottom: 7px; border: 1px solid #0052d9; background: #0052d9; color: white; border-radius: 6px; font-size: 10px; font-weight: bold; cursor: pointer;`;
    fixB.onclick = () => fillDateAndSearch(s12, e12);
    dBox.appendChild(fixB);

    const sel = document.createElement("select");
    sel.style.cssText = `width: 100%; padding: 3px; font-size: 11px; margin-bottom: 4px; cursor: pointer; border: 1px solid #d7e2f0; border-radius: 6px; background: #fff;`;
    for (let y = d.getFullYear(); y >= d.getFullYear() - 5; y--) {
        const opt = document.createElement("option");
        opt.value = y;
        opt.textContent = y + " 年";
        if (y === state.selectedYear) opt.selected = true;
        sel.appendChild(opt);
    }
    sel.onchange = (e) => { state.selectedYear = parseInt(e.target.value); updateDateButtons(dBox); };
    dBox.appendChild(sel);
    updateDateButtons(dBox);

    const foldBtn = menu.querySelector('[data-plugin-login-action="toggle-password"]');
    foldBtn.addEventListener("click", (e) => {
        const input = menu.querySelector('[data-plugin-login-field="pwd"]');
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        e.currentTarget.textContent = show ? "隐藏" : "显示";
    });
    menu.querySelector('[data-plugin-login-action="save-fill"]').addEventListener("click", () => submitPanelLogin(true));
    menu.querySelector('[data-plugin-login-action="fill"]').addEventListener("click", () => submitPanelLogin(false));
    menu.querySelector('[data-plugin-login-action="clear"]').addEventListener("click", resetCredentials);
    menu.querySelectorAll(".plugin-login-input").forEach((input) => {
        input.addEventListener("keydown", (e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            submitPanelLogin(true);
        });
    });

    syncSidebarPageState(menu);
    getSavedCredentials((creds) => {
        updateLoginPanelFields(creds);
        if (hasCompleteCredentials(creds)) {
            setLoginPanelStatus("已读取本机保存的账号，可一键填充", "ok");
        } else if (creds && (creds.code || creds.num || creds.pwd)) {
            setLoginPanelStatus("保存的账号信息不完整，请补全三项", "error");
        } else {
            setLoginPanelStatus("填写三项后点「保存并填充」即可复用", "muted");
        }
    });
}

// =====================================================
// === 4. 业务逻辑初始化 ===
// =====================================================

const TOTAL_BADGE_ID = "total-tax-fixed-display";

function ensureTotalBadge() {
    let el = document.getElementById(TOTAL_BADGE_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = TOTAL_BADGE_ID;
    el.style.cssText = `position: fixed; font-size: 13px; font-weight: bold; color: white; background: #1f1f1f; padding: 6px 12px; border-radius: 6px; z-index: 10000; cursor: pointer;`;
    document.body.appendChild(el);
    return el;
}

function runBusiness() {
    if (state.isRunning || state.isPrompting) return;
    state.isRunning = true;
    try {
        // 万元浮层不依赖 .info-number 选择器，先独立跑，避免选择器失效时跟着一起挂掉
        if (config.wanDisplayMode === "overlay") {
            renderWanOverlay();
        }

        // 先在汇总容器内取数，取不到再退回全局选择器（.info-number:nth-child(1) 容易被页面上别的元素抢中）
        const summaryEl = document.querySelector(config.summarySelector);
        const nums = summaryEl ? summaryEl.querySelectorAll(".info-number") : [];
        const amtEl = nums[0] || document.querySelector(config.totalAmountSelector);
        const taxEl = nums[1] || document.querySelector(config.totalTaxSelector);

        const tEl = ensureTotalBadge();

        // 没有汇总数据就藏起浮标，避免离开查询页后残留上一个区间的数字
        if (!amtEl || !taxEl) { tEl.style.display = "none"; return; }

        const amtStr = (amtEl.firstChild?.textContent || "").replace(/,/g, "").replace(/[^\d.-]/g, "");
        const taxStr = (taxEl.firstChild?.textContent || "").replace(/,/g, "").replace(/[^\d.-]/g, "");
        const amtV = parseFloat(amtStr);
        const taxV = parseFloat(taxStr);
        if (!isFinite(amtV) || !isFinite(taxV)) { tEl.style.display = "none"; return; }

        const total = (amtV + taxV).toFixed(2);

        // 超阈值标红；回落到阈值以下要还原，否则 Vue 复用节点时会一直红着
        if (amtV > config.highlightThreshold) {
            amtEl.style.color = config.highlightColor;
        } else if (amtEl.style.color) {
            amtEl.style.color = "";
        }

        if (config.wanDisplayMode === "inline") {
            // 旧做法：数字后面追加蓝色 (xx.xx万)
            [amtEl, taxEl].forEach((el, i) => {
                const v = i === 0 ? amtV : taxV;
                let wan = el.querySelector(".wan-unit-display");
                if (!wan) {
                    wan = document.createElement("span");
                    wan.className = "wan-unit-display";
                    wan.style.cssText = `margin-left: 6px; font-weight: bold; color: #1890ff; background: #e6f7ff; padding: 1px 4px; border-radius: 4px; cursor: pointer;`;
                    el.appendChild(wan);
                }
                wan.innerText = `(${(v / 10000).toFixed(2)}万)`;
                wan.onclick = (e) => copyToClipboard(i === 0 ? amtStr : taxStr, e);
            });
        } else {
            // 浮层模式：清掉可能残留的旧内联标签，避免一处显示两个万元值
            document.querySelectorAll(".wan-unit-display").forEach(el => el.remove());
        }

        if (state.lastTotalText !== total) {
            tEl.innerText = `价税合计: ¥${total}`;
            state.lastTotalText = total;
        }
        tEl.onclick = (e) => copyToClipboard(total, e);

        // 定位：随汇总区滚动；滚出视口就隐藏，不要浮在无关内容上
        const rect = amtEl.getBoundingClientRect();
        const wanRow = document.querySelector("." + WAN_ROW_CLASS);
        const wanRect = wanRow ? wanRow.getBoundingClientRect() : null;
        let top = null, left = 0, transform = "none";
        if (wanRect && wanRect.top > 0) {
            // 浮层模式下：与红色万元浮层同一水平线，紧贴其左侧摆放，互不遮挡
            top = Math.round(wanRect.top);
            left = Math.round(wanRect.left) - 12;
            transform = "translateX(-100%)";
        } else if (rect.top > 0) {
            // 旧布局：金额上方 45px
            top = Math.round(rect.top - 45);
            left = Math.round(rect.left);
        }

        if (top === null) {
            tEl.style.display = "none";
            return;
        }
        tEl.style.display = "block";
        tEl.style.top = `${top}px`;
        tEl.style.left = `${left}px`;
        tEl.style.transform = transform;

        // 表格行会被 Vue 复用，命中时打标记，不再命中时按标记还原，避免残留红色
        document.querySelectorAll(textConfig.selector).forEach(el => {
            const hit = config.typeHighlight !== false && el.textContent.includes(textConfig.targetText);
            if (hit) {
                el.dataset.pluginHl = "1";
                el.style.setProperty("color", config.highlightColor, "important");
                el.style.setProperty("font-weight", "bold", "important");
            } else if (el.dataset.pluginHl === "1") {
                delete el.dataset.pluginHl;
                el.style.removeProperty("color");
                el.style.removeProperty("font-weight");
            }
        });
    } catch (e) {
        console.warn("[TaxTally] runBusiness failed", e);
    } finally {
        state.isRunning = false;
    }
}

// =====================================================
// === 5. 定时刷新页面 ===
// =====================================================
const REFRESH_BADGE_ID = "plugin-refresh-badge";
const QUERY_STATE_KEY = "plugin_query_state";
const refreshRt = { timer: null, ticker: null, deadline: 0 };

function fmtLeft(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s} 秒`;
}

// 刷新范围判定：只认 URL，不依赖页面是否已渲染完
// login（默认）→ 仅 etax 的 /loginb/ 登录页；all → 全部税务页面
function refreshScopeOk() {
    if (S.refreshScope === "all") return true;
    return /^etax\./i.test(location.hostname) && /^\/loginb(\/|$)/i.test(location.pathname);
}

function ensureRefreshBadge() {
    let el = document.getElementById(REFRESH_BADGE_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = REFRESH_BADGE_ID;
    el.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483646;" +
        "background:#0052d9;color:#fff;font-size:12px;font-weight:600;padding:6px 12px;" +
        "border-radius:14px;box-shadow:0 4px 12px rgba(0,0,0,.22);cursor:pointer;" +
        "font-family:sans-serif;user-select:none;white-space:nowrap;";
    el.title = "点击立即刷新 · 右键取消本次定时刷新";
    el.addEventListener("click", () => doRefresh(true));
    el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        clearAutoRefresh();
        showToast("已暂停本次定时刷新", e.clientX, e.clientY, "#0052d9");
    });
    document.body.appendChild(el);
    return el;
}

function paintRefreshBadge() {
    if (!S.refreshBadge) {
        const old = document.getElementById(REFRESH_BADGE_ID);
        if (old) old.remove();
        return;
    }
    const el = ensureRefreshBadge();
    el.textContent = "🔄 " + fmtLeft(refreshRt.deadline - Date.now()) + " 后刷新";
}

function clearAutoRefresh() {
    if (refreshRt.timer) { clearTimeout(refreshRt.timer); refreshRt.timer = null; }
    if (refreshRt.ticker) { clearInterval(refreshRt.ticker); refreshRt.ticker = null; }
    refreshRt.deadline = 0;
    const el = document.getElementById(REFRESH_BADGE_ID);
    if (el) el.remove();
}

// 刷新前记录当前查询条件，刷新后自动回填并重查，否则刷新只会得到一个空结果页
function captureQueryState() {
    const g = (ph) => {
        const el = document.querySelector(`input[placeholder="${ph}"]`);
        return el ? el.value : "";
    };
    const start = g("开票日期起");
    const end = g("开票日期止");
    if (!start || !end) return null;
    return { start, end, at: Date.now() };
}

function saveQueryState() {
    if (!S.restoreQuery) return;
    const st = captureQueryState();
    if (!st) return;
    try { chrome.storage.local.set({ [QUERY_STATE_KEY]: st }); } catch (e) {}
}

function clickQueryButton() {
    const btns = Array.from(document.querySelectorAll("button"));
    const b = btns.find(x => (x.textContent || "").replace(/\s+/g, "") === "查询")
        || btns.find(x => /查\s*询/.test(x.textContent || ""));
    if (b) { b.click(); return true; }
    return false;
}

function doRefresh(saveState) {
    if (saveState !== false) saveQueryState();
    // 记录一次刷新时间，便于排查
    try { chrome.storage.local.set({ plugin_last_refresh: Date.now() }); } catch (e) {}
    // 留一点时间让上面的 storage 写入落盘，避免刚写完就 reload 导致条件丢失
    setTimeout(() => location.reload(), 120);
}

function setupAutoRefresh() {
    clearAutoRefresh();
    if (!S.autoRefresh) return;
    if (!refreshScopeOk()) return;

    const sec = Math.max(10, Number(S.refreshSeconds) || 60);
    const ms = sec * 1000;
    refreshRt.deadline = Date.now() + ms;

    if (S.refreshBadge) {
        paintRefreshBadge();
        refreshRt.ticker = setInterval(paintRefreshBadge, 1000);
    }

    refreshRt.timer = setTimeout(() => {
        // 后台标签页的定时器会被节流，可能提前触发；到点前再校准一次
        const left = refreshRt.deadline - Date.now();
        if (left > 1500) {
            refreshRt.timer = setTimeout(() => doRefresh(true), left);
        } else {
            doRefresh(true);
        }
    }, ms);
}

// 刷新后恢复上次的查询条件并自动重查（仅查询页模式有意义，登录页模式直接跳过）
function restoreQueryState() {
    if (!S.restoreQuery) return;
    if ((S.refreshScope || "login") === "login") return;
    if (!refreshScopeOk()) return;
    try {
        chrome.storage.local.get([QUERY_STATE_KEY], (r) => {
            const st = r && r[QUERY_STATE_KEY];
            if (!st || !st.start || !st.end) return;
            if (Date.now() - (st.at || 0) > 10 * 60 * 1000) return; // 超过 10 分钟不再恢复

            const t0 = Date.now();
            const waitForm = () => {
                const sIn = document.querySelector('input[placeholder="开票日期起"]');
                const eIn = document.querySelector('input[placeholder="开票日期止"]');
                if (!sIn || !eIn) {
                    if (Date.now() - t0 < 20000) setTimeout(waitForm, 300);
                    return;
                }
                nativeFill(sIn, st.start); sIn.blur();
                nativeFill(eIn, st.end); eIn.blur();

                const norm = (s) => String(s || "").replace(/[^\d]/g, "");
                setTimeout(() => {
                    if (norm(sIn.value) !== norm(st.start) || norm(eIn.value) !== norm(st.end)) return;
                    clickQueryButton();
                }, 900);
            };
            waitForm();
        });
    } catch (e) {}
}

// 面板 → 页面 的消息通道
try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || !msg.type) return;
        if (msg.type === "plugin-manual-refresh") {
            sendResponse({ ok: true });
            doRefresh(true);
        } else if (msg.type === "plugin-get-status") {
            sendResponse(buildStatus());
        } else if (msg.type === "plugin-run-batch") {
            sendResponse({ ok: true, running: batchRt.running });
            startBatch(msg.mode || "quarter", msg.year);
        } else if (msg.type === "plugin-export-csv") {
            sendResponse({ ok: exportCurrentTable() });
        }
        return true;
    });
} catch (e) {}

// =====================================================
// === 6. 批量汇总（按季 / 按月）与 CSV 导出 ===
// =====================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pad2(n) { return String(n).padStart(2, "0"); }
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

// 读当前汇总区：金额 / 税额（单位：元）
function readSummary() {
    const el = document.querySelector(config.summarySelector);
    if (!el) return null;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!/合\s*计\s*(金\s*额|税\s*额)/.test(text)) return null;
    const a = parseSummaryItem(text, "金\\s*额");
    const t = parseSummaryItem(text, "税\\s*额");
    if (!a && !t) return null;
    return {
        text,
        amount: a ? a.value : 0,
        tax: t ? t.value : 0,
        rawAmount: a ? a.raw : "",
        rawTax: t ? t.raw : ""
    };
}

// 生成要跑的区间列表
function buildRanges(mode, year) {
    const out = [];
    if (mode === "quarter") {
        for (let q = 1; q <= 4; q++) {
            const s = (q - 1) * 3 + 1, e = q * 3;
            out.push({
                label: `${q}季度`,
                start: `${year}-${pad2(s)}-01`,
                end: `${year}-${pad2(e)}-${pad2(daysInMonth(year, e))}`
            });
        }
    } else {
        for (let m = 1; m <= 12; m++) {
            out.push({
                label: `${pad2(m)}月`,
                start: `${year}-${pad2(m)}-01`,
                end: `${year}-${pad2(m)}-${pad2(daysInMonth(year, m))}`
            });
        }
    }
    return out;
}

// 只填日期不点查询，返回是否找到了输入框
function fillDateInputs(start, end) {
    const sIn = document.querySelector('input[placeholder="开票日期起"]');
    const eIn = document.querySelector('input[placeholder="开票日期止"]');
    if (!sIn || !eIn) return false;
    [[sIn, start], [eIn, end]].forEach(([input, v]) => { nativeFill(input, v); input.blur(); });
    return true;
}

function dateInputsMatch(start, end) {
    const sIn = document.querySelector('input[placeholder="开票日期起"]');
    const eIn = document.querySelector('input[placeholder="开票日期止"]');
    if (!sIn || !eIn) return false;
    const norm = (s) => String(s || "").replace(/[^\d]/g, "");
    return norm(sIn.value) === norm(start) && norm(eIn.value) === norm(end);
}

// 等汇总文本变化并稳定（连续 3 次采样一致），超时返回当前值
function waitSummaryChange(prevText, timeout) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        let last = null, stable = 0;
        const tick = () => {
            if (batchRt.abort) return resolve(null);
            const s = readSummary();
            if (s && s.text !== prevText) {
                if (s.text === last) stable++;
                else { last = s.text; stable = 0; }
                if (stable >= 2) return resolve(s);
            }
            if (Date.now() - t0 > timeout) return resolve(s || null);
            setTimeout(tick, 250);
        };
        setTimeout(tick, 500);
    });
}

// —— 结果浮层 ——
const BATCH_ID = "plugin-batch-panel";
let batchRt = { running: false, abort: false };
let batchRows = [];

function batchPanel() {
    let p = document.getElementById(BATCH_ID);
    if (p) return p;
    p = document.createElement("div");
    p.id = BATCH_ID;
    p.style.cssText = "position:fixed;top:10vh;left:50%;transform:translateX(-50%);width:440px;max-height:74vh;" +
        "display:flex;flex-direction:column;background:#fff;border-radius:10px;z-index:2147483647;" +
        "box-shadow:0 12px 40px rgba(0,0,0,.28);font:12px/1.5 'Microsoft YaHei',sans-serif;color:#1f2329;overflow:hidden;";
    p.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:#0052d9;color:#fff;">' +
          '<span id="plugin-batch-title" style="font-weight:600;font-size:13px;">批量汇总</span>' +
          '<span id="plugin-batch-close" style="cursor:pointer;font-size:17px;line-height:1;opacity:.85;">&times;</span>' +
        '</div>' +
        '<div id="plugin-batch-sub" style="padding:6px 14px;background:#f5f7fa;color:#6b7280;font-size:11px;border-bottom:1px solid #eef0f4;">准备中…</div>' +
        '<div id="plugin-batch-body" style="overflow:auto;padding:0 14px 8px;flex:1;"></div>' +
        '<div style="display:flex;gap:8px;padding:9px 14px;border-top:1px solid #eef0f4;background:#fafbfc;">' +
          '<button id="plugin-batch-csv" style="flex:1;padding:6px 0;border:1px solid #0052d9;background:#0052d9;color:#fff;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">导出 CSV</button>' +
          '<button id="plugin-batch-cancel" style="flex:1;padding:6px 0;border:1px solid #dcdfe6;background:#fff;color:#4b5563;border-radius:5px;font-size:11px;cursor:pointer;">取消</button>' +
        '</div>';
    document.body.appendChild(p);

    p.querySelector("#plugin-batch-close").onclick = () => {
        batchRt.abort = true;
        p.remove();
        setupAutoRefresh();
    };
    p.querySelector("#plugin-batch-cancel").onclick = () => {
        if (batchRt.running) {
            batchRt.abort = true;
            p.querySelector("#plugin-batch-sub").textContent = "正在停止…";
        } else {
            p.remove();
        }
    };
    p.querySelector("#plugin-batch-csv").onclick = () => exportBatchCsv();
    return p;
}

function renderBatchBody() {
    const body = document.getElementById("plugin-batch-body");
    if (!body) return;
    if (!batchRows.length) {
        body.innerHTML = '<div style="padding:16px 0;color:#9aa1ac;text-align:center;">等待第一段结果…</div>';
        return;
    }
    const sa = batchRows.reduce((s, r) => s + (r.amount || 0), 0);
    const st = batchRows.reduce((s, r) => s + (r.tax || 0), 0);
    const cell = "padding:4px 6px;border-bottom:1px solid #f0f2f5;";
    const num = cell + "text-align:right;font-family:Consolas,monospace;";
    const trs = batchRows.map((r) =>
        "<tr>" +
        `<td style="${cell}">${r.label}</td>` +
        `<td style="${num}">${r.failed ? '<span style="color:#c0c4cc">失败</span>' : fmtThousands(r.amount || 0, 2)}</td>` +
        `<td style="${num}">${r.failed ? "—" : fmtThousands(r.tax || 0, 2)}</td>` +
        `<td style="${num}color:#e02020;font-weight:600;">${r.failed ? "—" : fmtThousands((r.amount || 0) + (r.tax || 0), 2)}</td>` +
        "</tr>"
    ).join("");
    body.innerHTML =
        '<table style="width:100%;border-collapse:collapse;font-size:11px;">' +
        '<thead><tr style="color:#6b7280;">' +
        '<th style="text-align:left;padding:5px 6px;font-weight:600;">区间</th>' +
        '<th style="text-align:right;padding:5px 6px;font-weight:600;">金额</th>' +
        '<th style="text-align:right;padding:5px 6px;font-weight:600;">税额</th>' +
        '<th style="text-align:right;padding:5px 6px;font-weight:600;">价税合计</th>' +
        "</tr></thead><tbody>" + trs + "</tbody>" +
        '<tfoot><tr style="background:#fafbfc;">' +
        '<td style="padding:5px 6px;font-weight:700;">合计</td>' +
        `<td style="padding:5px 6px;text-align:right;font-weight:700;font-family:Consolas,monospace;">${fmtThousands(sa, 2)}</td>` +
        `<td style="padding:5px 6px;text-align:right;font-weight:700;font-family:Consolas,monospace;">${fmtThousands(st, 2)}</td>` +
        `<td style="padding:5px 6px;text-align:right;font-weight:700;color:#e02020;font-family:Consolas,monospace;">${fmtThousands(sa + st, 2)}</td>` +
        "</tr></tfoot></table>";
}

async function startBatch(mode, year) {
    if (batchRt.running) {
        showToast("批量汇总正在进行中", window.innerWidth / 2, 120, "#fa8c16");
        return;
    }
    if (!document.querySelector('input[placeholder="开票日期起"]')) {
        showToast("请先进入发票查询页", window.innerWidth / 2, 120, "#ff4d4f");
        return;
    }

    const y = Number(year) || new Date().getFullYear();
    const ranges = buildRanges(mode, y);
    batchRt.running = true;
    batchRt.abort = false;
    batchRows = [];

    const panel = batchPanel();
    renderBatchBody();
    const title = panel.querySelector("#plugin-batch-title");
    const sub = panel.querySelector("#plugin-batch-sub");
    title.textContent = (mode === "quarter" ? "按季度汇总" : "按月度汇总") + " · " + y + " 年";
    sub.textContent = "准备开始…";

    clearAutoRefresh();   // 批量期间不要被定时刷新打断

    let prevText = (readSummary() || {}).text || "";
    for (let i = 0; i < ranges.length; i++) {
        if (batchRt.abort) break;
        const r = ranges[i];
        sub.textContent = `${i + 1}/${ranges.length} 查询中 · ${r.label}（${r.start} ~ ${r.end}）`;

        if (!fillDateInputs(r.start, r.end)) {
            batchRows.push({ label: r.label, amount: 0, tax: 0, failed: true });
            renderBatchBody();
            continue;
        }
        await sleep(400);
        if (batchRt.abort) break;

        if (!dateInputsMatch(r.start, r.end) || !clickQueryButton()) {
            batchRows.push({ label: r.label, amount: 0, tax: 0, failed: true });
            renderBatchBody();
            continue;
        }

        const s = await waitSummaryChange(prevText, 12000);
        if (batchRt.abort) break;
        if (s) {
            prevText = s.text;
            batchRows.push({ label: r.label, amount: s.amount, tax: s.tax, failed: false });
        } else {
            batchRows.push({ label: r.label, amount: 0, tax: 0, failed: true });
        }
        renderBatchBody();
    }

    batchRt.running = false;
    const sa = batchRows.reduce((s, r) => s + (r.amount || 0), 0);
    const st = batchRows.reduce((s, r) => s + (r.tax || 0), 0);
    const done = batchRows.filter((r) => !r.failed).length;

    if (batchRt.abort) {
        sub.textContent = `已停止，完成 ${done} 段`;
    } else {
        sub.innerHTML = `完成 ${done}/${ranges.length} 段 · 合计 <b>${fmtThousands(sa, 2)}</b> 元 ≈ <b>${(sa / 10000).toFixed(4)}</b> 万元（价税 ${fmtThousands(sa + st, 2)}）`;
        showToast("✓ 批量汇总完成", window.innerWidth / 2, 120, "#52c41a");
    }
    setupAutoRefresh();
}

// —— CSV ——
function downloadCsv(filename, rows) {
    try {
        const esc = (v) => {
            const s = v === null || v === undefined ? "" : String(v);
            return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const csv = "\uFEFF" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 5000);
        return true;
    } catch (e) {
        return false;
    }
}

function exportBatchCsv() {
    if (!batchRows.length) {
        showToast("还没有可导出的数据", window.innerWidth / 2, 120, "#ff4d4f");
        return;
    }
    const rows = [["区间", "金额(元)", "税额(元)", "价税合计(元)", "状态"]];
    let sa = 0, st = 0;
    batchRows.forEach((r) => {
        const a = r.amount || 0, t = r.tax || 0;
        sa += a; st += t;
        rows.push([
            r.label,
            a.toFixed(2),
            t.toFixed(2),
            (a + t).toFixed(2),
            r.failed ? "查询失败" : "正常"
        ]);
    });
    rows.push(["合计", sa.toFixed(2), st.toFixed(2), (sa + st).toFixed(2), ""]);
    const ok = downloadCsv(`汇总_${new Date().toISOString().slice(0, 10)}.csv`, rows);
    showToast(ok ? "✓ 已导出 CSV" : "✗ 导出失败", window.innerWidth / 2, 110, ok ? "#52c41a" : "#ff4d4f");
}

// 抓当前页最大的表格（原生 table 优先，虚拟表格兜底）
function extractTableRows() {
    const cands = Array.from(document.querySelectorAll("table"))
        .map((t) => ({ t, n: t.querySelectorAll("tbody tr").length }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n);

    if (cands.length) {
        const rows = [];
        cands[0].t.querySelectorAll("tr").forEach((tr) => {
            const cells = Array.from(tr.children).map((td) => (td.textContent || "").replace(/\s+/g, " ").trim());
            if (cells.some((c) => c)) rows.push(cells);
        });
        return rows;
    }

    const rowEls = Array.from(document.querySelectorAll('[role="row"], .t-table__row'));
    if (!rowEls.length) return null;
    return rowEls
        .map((r) => Array.from(r.querySelectorAll('[role="gridcell"], [role="cell"], td, .t-table__cell'))
            .map((c) => (c.textContent || "").replace(/\s+/g, " ").trim()))
        .filter((r) => r.some((c) => c));
}

function exportCurrentTable() {
    const rows = extractTableRows();
    if (!rows || rows.length < 2) {
        showToast("当前页面没有可导出的表格", window.innerWidth / 2, 120, "#ff4d4f");
        return false;
    }
    const ok = downloadCsv(`发票明细_${new Date().toISOString().slice(0, 10)}.csv`, rows);
    showToast(ok ? `✓ 已导出 ${rows.length - 1} 行` : "✗ 导出失败", window.innerWidth / 2, 110, ok ? "#52c41a" : "#ff4d4f");
    return ok;
}

// =====================================================
// === 6.5 dppt 查询页：返回首页的迷你入口 ===
// =====================================================
const DPPT_HOME_ID = "plugin-dppt-home";
const DPPT_HOME_URL = "https://etax.hubei.chinatax.gov.cn:8443/loginb/";
let dpptHomeLock = false;

// 关键：dppt 页装了外链安全 SDK，会接管所有 <a href> 的点击——
// 它在点击时把 href 改写成 "?XXXX=<超长令牌>"，然后 preventDefault 却不真正跳转，
// 表现就是「按钮点下去没反应」。所以这里不用 <a>，改成普通元素 + 自己导航。
function dpptGoHome(e) {
    const t = e.target;
    const el = t && t.closest ? t.closest("#" + DPPT_HOME_ID) : null;
    if (!el) return;
    // window 捕获阶段最先执行，stopImmediatePropagation 让页面自己的点击逻辑完全看不到这次点击
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (dpptHomeLock) return;             // 防止 pointerdown / click 双触发
    dpptHomeLock = true;
    el.style.opacity = "0.6";
    // 程序化跳转不受 preventDefault 影响，这是绕开 SDK 的关键
    setTimeout(() => { location.assign(DPPT_HOME_URL); }, 0);
    // 万一跳转被取消（例如页面自身的拦截），2.5 秒后解锁，按钮不会永久失效
    setTimeout(() => { dpptHomeLock = false; el.style.opacity = "1"; }, 2500);
}

function bindDpptHomeOnce() {
    if (window.__pluginDpptHomeBound) return;
    window.__pluginDpptHomeBound = true;
    // pointerdown 先兜底：即使页面在 mousedown 上吞掉事件，这里也已经跳了
    ["pointerdown", "click"].forEach(t =>
        window.addEventListener(t, dpptGoHome, true)
    );
}

function createDpptHome() {
    if (!/^dppt\./i.test(location.hostname)) return;
    if (!/invoice-query/i.test(location.href)) return;
    bindDpptHomeOnce();
    if (document.getElementById(DPPT_HOME_ID)) return;

    const el = document.createElement("div");
    el.id = DPPT_HOME_ID;
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.title = "返回电子税务局首页";
    el.textContent = "← 返回税务首页";
    el.style.cssText = "position:fixed;right:16px;top:12px;z-index:2147483647;background:#fff;color:#0052d9;" +
        "border:1px solid #b5d4f4;border-radius:14px;padding:5px 12px;font:600 12px/1.2 'Microsoft YaHei',sans-serif;" +
        "box-shadow:0 2px 8px rgba(0,0,0,.12);white-space:nowrap;cursor:pointer;user-select:none;" +
        "pointer-events:auto;transition:background .15s,opacity .15s;";
    el.addEventListener("mouseenter", () => { el.style.background = "#f0f7ff"; });
    el.addEventListener("mouseleave", () => { el.style.background = "#fff"; });
    document.body.appendChild(el);
}

// =====================================================
// === 6.6 面板状态回显 ===
// =====================================================
function buildStatus() {
    const s = readSummary();
    return {
        onTax: /hubei\.chinatax\.gov\.cn$/i.test(location.hostname),
        host: location.hostname,
        page: /^dppt\./i.test(location.hostname) ? "dppt"
            : (/^etax\./i.test(location.hostname) ? "etax"
                : (/^tpass\./i.test(location.hostname) ? "tpass" : "other")),
        onLogin: isLoginPage(),
        hasForm: !!document.querySelector('input[placeholder="开票日期起"]'),
        amount: s ? s.amount : null,
        tax: s ? s.tax : null,
        autoRefresh: !!S.autoRefresh,
        refreshLeft: refreshRt.deadline ? Math.max(0, refreshRt.deadline - Date.now()) : 0,
        scopeOk: refreshScopeOk(),
        running: batchRt.running
    };
}

// =====================================================
// === 7. 启动 ===
// =====================================================
function boot() {
    applySettings();

    runBusiness();
    createQuickNavMenu();
    createDpptHome();
    setupAutoRefresh();
    restoreQueryState();

    // 主循环：兜底刷新（后台标签页会被 Chrome 节流，最慢约 1 分钟一次）
    setInterval(() => {
        runBusiness();
        createQuickNavMenu();
        createDpptHome();
    }, 1500);

    // DOM 变更即时重建：Vue 重新渲染表格时会把浮层节点一起清掉，
    // 只靠定时器会出现"浮层消失一阵子"的空档
    let moTimer = null;
    try {
        const mo = new MutationObserver(() => {
            if (moTimer) return;
            moTimer = setTimeout(() => {
                moTimer = null;
                runBusiness();
                createQuickNavMenu();
            }, 200);
        });
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch (e) {}
}

// 读设置后再启动，避免首帧用默认值渲染出不符合配置的样式
try {
    chrome.storage.sync.get({ [SETTINGS_KEY]: SETTINGS_DEFAULTS }, (res) => {
        S = Object.assign({}, SETTINGS_DEFAULTS, (res && res[SETTINGS_KEY]) || {});
        boot();
    });
} catch (e) {
    boot();
}

// 面板改动后实时生效
try {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[config.storageKey]) {
            updateLoginPanelFields(changes[config.storageKey].newValue || null);
            return;
        }
        if (area !== "sync" || !changes[SETTINGS_KEY]) return;
        S = Object.assign({}, SETTINGS_DEFAULTS, changes[SETTINGS_KEY].newValue || {});
        applySettings();

        // 样式类配置变化需要整体重绘（文本没变时 dataset.src 会拦住重绘）
        clearWanOverlay();
        document.querySelectorAll(".wan-unit-display").forEach(el => el.remove());
        runBusiness();
        setupAutoRefresh();

        if (S.wanDisplayMode !== "off" && S.wanDisplayMode !== "inline") {
            setTimeout(renderWanOverlay, 60);
        }
    });
} catch (e) {}

// 补充触发：后台标签页里定时器会被 Chrome 节流（最慢约 1 分钟一次），
// 切回前台、滚动、缩放窗口时立刻补一次，避免浮标停在旧位置或旧数字上
let tickScheduled = false;
function tickSoon() {
    if (tickScheduled) return;
    tickScheduled = true;
    requestAnimationFrame(() => { tickScheduled = false; runBusiness(); });
}

window.addEventListener("scroll", tickSoon, true);   // capture 兼容页面内部的滚动容器
window.addEventListener("resize", tickSoon);
window.addEventListener("hashchange", () => createQuickNavMenu());
document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    runBusiness();
    createQuickNavMenu();
    // 后台期间定时器被节流，回前台时若已过点就立刻刷新
    if (S.autoRefresh && refreshRt.deadline && Date.now() >= refreshRt.deadline - 800) {
        doRefresh(true);
    }
});






