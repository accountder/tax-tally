/**
 * 设置面板逻辑（与 content.js 共用同一份存储结构）
 */
(function () {
  'use strict';

  const KEY = 'plugin_settings_v2';

  const DEFAULTS = {
    /* 万元显示 */
    wanDisplayMode: 'overlay',   // overlay | inline | off
    amountToWan: true,
    taxToWan: true,
    wanDecimals: 4,
    wanColor: '#e02020',
    wanFontSize: 15,
    wanBold: true,
    unitAuto: true,
    /* 高亮 */
    thresholdOn: true,
    highlightThreshold: 300000,
    typeHighlight: true,
    /* 定时刷新 */
    autoRefresh: false,
    refreshSeconds: 60,
    refreshScope: 'login',       // login（仅登录页）| all
    restoreQuery: true,
    refreshBadge: true
  };

  /* 页面没有真实数据时的示例值（纯虚构，与发票查询结果同量级） */
  const SAMPLE = { amount: 123456.78, tax: 1234.57 };

  let S = Object.assign({}, DEFAULTS);
  let LIVE = null;        // content.js 回传的当前页状态
  let statusTimer = null;

  const $ = (id) => document.getElementById(id);

  function thousands(n, d) {
    const parts = Math.abs(n).toFixed(d).split('.');
    const int = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + int + (parts[1] ? '.' + parts[1] : '');
  }

  /* 与 content.js 的 pickUnit 保持一致 */
  function pickUnit(num) {
    if (S.unitAuto !== false && Math.abs(num) >= 1e8) {
      return { div: 1e8, unit: '亿元', decimals: Number(S.wanDecimals) };
    }
    return { div: 1e4, unit: '万元', decimals: Number(S.wanDecimals) };
  }

  function badgeHtml(num) {
    const u = pickUnit(num);
    const v = num === 0 ? '0' : thousands(num / u.div, u.decimals);
    const numStyle = 'font-size:' + S.wanFontSize + 'px;color:' + S.wanColor + ';' +
      (S.wanBold ? 'font-weight:700;' : '');
    return '<span style="' + numStyle + '">' + v + '</span>' +
           '<span style="color:' + S.wanColor + ';' + (S.wanBold ? 'font-weight:600;' : '') + '">' +
           u.unit + '</span>';
  }

  function renderPreview() {
    const box = $('previewText');
    const cap = $('previewCap');
    if (!box) return;

    const liveA = LIVE && typeof LIVE.amount === 'number' ? LIVE.amount : null;
    const liveT = LIVE && typeof LIVE.tax === 'number' ? LIVE.tax : null;
    const hasLive = liveA !== null || liveT !== null;

    cap.textContent = hasLive ? '当前页面实际数据' : '示例数据（本页未识别到汇总）';

    if (S.wanDisplayMode === 'off') {
      box.innerHTML = '<span style="color:#9aa1ac">已关闭万元显示</span>';
      return;
    }

    const amt = liveA !== null ? liveA : SAMPLE.amount;
    const tax = liveT !== null ? liveT : SAMPLE.tax;

    if (S.wanDisplayMode === 'inline') {
      const a = S.amountToWan ? '（' + thousands(amt / 10000, 2) + '万）' : '';
      const t = S.taxToWan ? '（' + thousands(tax / 10000, 2) + '万）' : '';
      box.innerHTML =
        '合计金额：' + thousands(amt, 2) + '元<span style="color:#1890ff;font-weight:700">' + a + '</span><br>' +
        '合计税额：' + thousands(tax, 2) + '元<span style="color:#1890ff;font-weight:700">' + t + '</span>';
      return;
    }

    const parts = [];
    if (S.amountToWan) parts.push('合计金额：' + badgeHtml(amt));
    if (S.taxToWan) parts.push('合计税额：' + badgeHtml(tax));
    box.innerHTML = parts.length
      ? parts.join('<br>')
      : '<span style="color:#9aa1ac">金额与税额均已关闭</span>';
  }

  /* ---------- 状态条 ---------- */

  function paintNotes() {
    const st = LIVE;

    /* 高亮 */
    const hl = $('noteHl');
    if (hl) {
      if (!st || typeof st.amount !== 'number') {
        hl.textContent = '当前页未识别到合计金额，查询出结果后才会标红。';
      } else if (S.thresholdOn && st.amount > Number(S.highlightThreshold || 0)) {
        hl.innerHTML = '当前合计 <b>' + thousands(st.amount, 2) + '</b> 元，已超过阈值，原始数字已标红。';
      } else {
        hl.innerHTML = '当前合计 <b>' + thousands(st.amount, 2) + '</b> 元，' +
          (S.thresholdOn
            ? '未超过 ' + thousands(Number(S.highlightThreshold || 0), 0) + ' 元阈值。'
            : '阈值标红已关闭。');
      }
    }

    /* 刷新 */
    const rf = $('noteRf');
    if (rf) {
      const sec = Number(S.refreshSeconds) || 60;
      const label = sec >= 60 ? Math.round(sec / 60) + ' 分钟' : sec + ' 秒';
      if (!S.autoRefresh) {
        rf.textContent = '定时刷新未启用。';
      } else if (!st) {
        rf.textContent = '当前页未注入插件，无法判断生效范围。';
      } else if (st.scopeOk) {
        rf.innerHTML = '当前页在生效范围内，约每 <b>' + label + '</b> 刷新一次' +
          (st.onLogin ? '（登录页）' : '') + '。';
      } else if (S.refreshScope === 'all') {
        rf.textContent = '当前页属于「全部税务页面」范围，会按时刷新。';
      } else {
        rf.textContent = '当前页不在生效范围内：只刷新 /loginb/ 登录页，其余页面不动。';
      }
    }

    /* 工具 */
    const tl = $('noteTl');
    if (tl) {
      if (!st) tl.textContent = '请先打开税务页面。';
      else if (!st.hasForm) tl.textContent = '当前页没有开票日期条件，批量汇总需在发票查询页使用。';
      else tl.textContent = '当前页已就绪，可以开始批量查询并汇总。';
    }
  }

  function paintStatus(st) {
    const el = $('pageStatus');
    const txt = el.querySelector('.txt');
    LIVE = null;

    if (!st || !st.onTax) {
      el.classList.remove('ok');
      txt.textContent = st === null ? '当前页未注入插件（请打开税务页面）' : '当前页不是湖北电子税务局，功能不生效';
      renderPreview();
      paintNotes();
      return;
    }

    LIVE = st;
    let s;
    if (st.page === 'dppt') s = '发票业务页';
    else if (st.onLogin) s = '登录页 /loginb/';
    else s = '电子税务局首页';

    if (typeof st.amount === 'number') {
      s += ' · 合计 <b>' + thousands(st.amount, 2) + '</b> 元';
    } else if (st.hasForm) {
      s += ' · 未识别到汇总';
    } else {
      s += ' · 无汇总数据';
    }

    el.classList.add('ok');
    txt.innerHTML = s;
    renderPreview();
    paintNotes();
  }

  function askStatus() {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || !tab.id) { paintStatus(null); return; }
        chrome.tabs.sendMessage(tab.id, { type: 'plugin-get-status' }, (res) => {
          const failed = chrome.runtime.lastError || !res;
          paintStatus(failed ? null : res);
        });
      });
    } catch (e) {
      paintStatus(null);
    }
  }

  /* ---------- 联动禁用 ---------- */

  function syncDisabled() {
    // 依赖某个开关的行
    document.querySelectorAll('[data-need]').forEach((row) => {
      let on = !!S[row.dataset.need];
      if (row.dataset.loginOff === '1' && (S.refreshScope || 'login') === 'login') on = false;
      row.classList.toggle('disabled', !on);
      row.querySelectorAll('select,input').forEach((i) => { i.disabled = !on; });
    });

    // 万元整组
    const wanOff = S.wanDisplayMode === 'off';
    ['amountToWan', 'taxToWan', 'wanDecimals', 'unitAuto', 'wanColor', 'wanFontSize', 'wanBold']
      .forEach((id) => {
        const el = $(id);
        if (!el) return;
        el.disabled = wanOff;
        const row = el.closest('.row');
        if (row) row.classList.toggle('disabled', wanOff);
      });
  }

  function paintSwatches() {
    document.querySelectorAll('.sw').forEach((sw) => {
      sw.classList.toggle('on', sw.dataset.color.toLowerCase() === String(S.wanColor).toLowerCase());
    });
  }

  /* ---------- 控件 ↔ 配置 ---------- */

  function applyToForm() {
    $('wanDisplayMode').value = S.wanDisplayMode;
    $('amountToWan').checked = !!S.amountToWan;
    $('taxToWan').checked = !!S.taxToWan;
    $('wanDecimals').value = String(S.wanDecimals);
    $('unitAuto').checked = S.unitAuto !== false;
    $('wanColor').value = S.wanColor;
    $('wanFontSize').value = S.wanFontSize;
    $('fontSizeVal').textContent = S.wanFontSize + 'px';
    $('wanBold').checked = !!S.wanBold;

    $('thresholdOn').checked = !!S.thresholdOn;
    $('highlightThreshold').value = S.highlightThreshold;
    $('typeHighlight').checked = !!S.typeHighlight;

    $('autoRefresh').checked = !!S.autoRefresh;
    $('refreshSeconds').value = String(S.refreshSeconds);
    $('refreshScope').value = S.refreshScope;
    $('restoreQuery').checked = !!S.restoreQuery;
    $('refreshBadge').checked = !!S.refreshBadge;

    paintSwatches();
    syncDisabled();
    renderPreview();
    paintNotes();
  }

  function setStatus(text, ok) {
    const st = $('status');
    st.textContent = text;
    st.className = ok ? 'ok' : '';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { st.textContent = ''; st.className = ''; }, 2200);
  }

  let saveTimer = null;
  function save(immediate) {
    const doSave = () => {
      chrome.storage.sync.set({ [KEY]: S }, () => {
        setStatus('✓ 已保存', true);
      });
    };
    if (immediate) { clearTimeout(saveTimer); doSave(); return; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 250);
  }

  /* ---------- 事件绑定 ---------- */

  function bindTabs() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === tab));
        document.querySelectorAll('.pane').forEach((p) => {
          p.classList.toggle('on', p.id === 'pane-' + tab.dataset.pane);
        });
      });
    });
  }

  /* 当前标签页 */
  function withTab(fn) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || !tab.id) { fn(null); return; }
        fn(tab);
      });
    } catch (e) { fn(null); }
  }

  function bind() {
    $('wanDisplayMode').addEventListener('change', (e) => {
      S.wanDisplayMode = e.target.value;
      applyToForm(); save(true);
    });

    $('amountToWan').addEventListener('change', (e) => {
      S.amountToWan = e.target.checked; renderPreview(); save(true);
    });
    $('taxToWan').addEventListener('change', (e) => {
      S.taxToWan = e.target.checked; renderPreview(); save(true);
    });
    $('wanDecimals').addEventListener('change', (e) => {
      S.wanDecimals = Number(e.target.value); renderPreview(); save(true);
    });
    $('unitAuto').addEventListener('change', (e) => {
      S.unitAuto = e.target.checked; renderPreview(); save(true);
    });
    $('wanColor').addEventListener('input', (e) => {
      S.wanColor = e.target.value; paintSwatches(); renderPreview(); save(false);
    });
    $('wanFontSize').addEventListener('input', (e) => {
      S.wanFontSize = Number(e.target.value);
      $('fontSizeVal').textContent = S.wanFontSize + 'px';
      renderPreview(); save(false);
    });
    $('wanBold').addEventListener('change', (e) => {
      S.wanBold = e.target.checked; renderPreview(); save(true);
    });

    document.querySelectorAll('.sw').forEach((sw) => {
      sw.addEventListener('click', () => {
        S.wanColor = sw.dataset.color;
        $('wanColor').value = S.wanColor;
        paintSwatches(); renderPreview(); save(true);
      });
    });

    $('thresholdOn').addEventListener('change', (e) => {
      S.thresholdOn = e.target.checked; applyToForm(); save(true);
    });
    $('highlightThreshold').addEventListener('change', (e) => {
      const v = Math.max(0, Number(e.target.value) || 0);
      S.highlightThreshold = v;
      e.target.value = v;
      save(true);
    });
    $('typeHighlight').addEventListener('change', (e) => {
      S.typeHighlight = e.target.checked; save(true);
    });

    $('autoRefresh').addEventListener('change', (e) => {
      S.autoRefresh = e.target.checked; applyToForm(); save(true);
    });
    $('refreshSeconds').addEventListener('change', (e) => {
      S.refreshSeconds = Number(e.target.value); save(true);
    });
    $('refreshScope').addEventListener('change', (e) => {
      S.refreshScope = e.target.value; applyToForm(); save(true);
    });
    $('restoreQuery').addEventListener('change', (e) => {
      S.restoreQuery = e.target.checked; save(true);
    });
    $('refreshBadge').addEventListener('change', (e) => {
      S.refreshBadge = e.target.checked; save(true);
    });

    $('refreshNow').addEventListener('click', () => {
      withTab((tab) => {
        if (!tab) { setStatus('当前页无法刷新', false); return; }
        chrome.tabs.sendMessage(tab.id, { type: 'plugin-manual-refresh' }, () => {
          if (chrome.runtime.lastError) chrome.tabs.reload(tab.id);
          window.close();
        });
      });
    });

    $('runBatch').addEventListener('click', () => {
      const mode = $('batchMode').value;
      const year = Number($('batchYear').value) || new Date().getFullYear();
      setStatus('已发送，正在启动…', true);
      withTab((tab) => {
        if (!tab) { setStatus('当前页无插件', false); return; }
        chrome.tabs.sendMessage(tab.id, { type: 'plugin-run-batch', mode, year }, (res) => {
          if (chrome.runtime.lastError || !res || !res.ok) {
            setStatus('请先在发票查询页打开', false);
            return;
          }
          setStatus('已开始，关闭面板看进度', true);
          setTimeout(() => window.close(), 700);
        });
      });
    });

    $('exportCsv').addEventListener('click', () => {
      withTab((tab) => {
        if (!tab) { setStatus('当前页无插件', false); return; }
        chrome.tabs.sendMessage(tab.id, { type: 'plugin-export-csv' }, (res) => {
          if (chrome.runtime.lastError || !res) { setStatus('导出失败', false); return; }
          setStatus(res.ok ? '✓ 已导出' : '当前页没有表格', res.ok);
        });
      });
    });

    $('resetCreds').addEventListener('click', () => {
      if (!confirm('确定要清空已保存的账号吗？（所有税务页面都将重置）')) return;
      chrome.storage.local.remove('plugin_tax_user_info', () => {
        setStatus('✓ 账号已清空', true);
      });
    });

    $('resetAll').addEventListener('click', () => {
      if (!confirm('把所有设置恢复为默认值？')) return;
      S = Object.assign({}, DEFAULTS);
      chrome.storage.sync.set({ [KEY]: S }, () => {
        applyToForm();
        setStatus('✓ 已恢复默认', true);
      });
    });
  }

  function initBatchYear() {
    const y = new Date().getFullYear();
    const sel = $('batchYear');
    for (let i = y; i >= y - 4; i--) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = i + ' 年';
      sel.appendChild(o);
    }
  }

  /* ---------- 启动 ---------- */
  chrome.storage.sync.get({ [KEY]: DEFAULTS }, (res) => {
    S = Object.assign({}, DEFAULTS, (res && res[KEY]) || {});
    if (S.refreshScope !== 'all') S.refreshScope = 'login';

    initBatchYear();
    applyToForm();
    bindTabs();
    bind();
    askStatus();

    // 另一个窗口改了设置时同步过来
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes[KEY]) return;
      S = Object.assign({}, DEFAULTS, changes[KEY].newValue || {});
      if (S.refreshScope !== 'all') S.refreshScope = 'login';
      applyToForm();
    });
  });
})();
