'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = { tab: 'cards', cardNo: null, logCardNo: '', staff: [], filter: 'all' };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.message || `请求失败 ${res.status}`);
  return data;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let toastTimer = null;
function toast(message, kind = '') {
  let el = $('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.className = 'toast ' + kind;
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), kind === 'error' ? 9000 : 4500);
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [tab, arg] = h.split('/');
  state.tab = ['cards', 'staff', 'retains', 'log'].includes(tab) ? tab : 'cards';
  state.cardNo = state.tab === 'cards' ? (arg || null) : null;
  state.logCardNo = state.tab === 'log' ? (arg || '') : '';
}
function go(hash) { location.hash = '#/' + hash; }
window.addEventListener('hashchange', render);
$$('nav.tabs button').forEach((btn) => btn.addEventListener('click', () => go(btn.dataset.tab)));

async function render() {
  parseHash();
  $$('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  const view = $('#view');
  view.innerHTML = '<p class="muted">加载中…</p>';
  try {
    if (!state.staff.length) state.staff = (await api('/api/staff')).staff;
    if (state.tab === 'cards') state.cardNo ? renderCard(view) : renderList(view);
    if (state.tab === 'staff') renderStaff(view);
    if (state.tab === 'retains') renderRetains(view);
    if (state.tab === 'log') renderLog(view);
  } catch (err) {
    view.innerHTML = '';
    toast('加载失败：' + err.message, 'error');
  }
}

function pickStaff(promptText, trade, { allowAny = false } = {}) {
  const qualified = trade
    ? state.staff.filter((p) => p.qualifications.some((q) => q.trade === trade))
    : state.staff;
  const pool = allowAny ? state.staff : qualified;
  const list = pool.map((p, i) => `${i + 1}. ${p.staffId} ${p.name}` +
    (trade && !p.qualifications.some((q) => q.trade === trade) ? `（无「${trade}」资质，后端会拒绝）` : '')).join('\n');
  const ans = prompt(promptText + '\n' + list, '1');
  if (!ans) return null;
  const idx = Number(ans) - 1;
  return pool[idx] ? pool[idx].staffId : null;
}

// ---------------------------------------------------------------------------
// 工卡列表
// ---------------------------------------------------------------------------

async function renderList(view) {
  const data = await api('/api/overview');
  $('#policy-box').innerHTML =
    `今日 ${esc(data.asOf)} ｜ 严格放行 <b>${data.counts.strictReady}</b> 份` +
    ` ｜ 若只按“步骤签完”（宽松口径）则 ${data.counts.looseReady} 份 ｜ 共 ${data.counts.total} 份`;

  view.innerHTML = `
    <div class="toolbar">
      <label>筛选：</label>
      <select id="filter">
        <option value="all">全部工卡</option>
        <option value="review-today">今日该复查</option>
        <option value="overdue">复查已超期</option>
        <option value="part-open">有缺件保留项</option>
        <option value="routine">例行工卡</option>
        <option value="troubleshooting">排故工卡</option>
        <option value="loose-only">宽松能过 / 严格不能过</option>
      </select>
      <span class="muted">点击卡片进入步骤树</span>
    </div>
    <div class="cards" id="cards"></div>`;
  $('#filter').value = state.filter;
  $('#filter').addEventListener('change', (e) => { state.filter = e.target.value; drawCards(data.cards); });
  drawCards(data.cards);
}

function drawCards(cards) {
  let list = cards;
  if (state.filter === 'review-today') list = list.filter((c) => c.hasDueTodayReview);
  if (state.filter === 'overdue') list = list.filter((c) => c.hasOverdueReview);
  if (state.filter === 'part-open') list = list.filter((c) => c.openPartRetains > 0);
  if (state.filter === 'routine') list = list.filter((c) => c.type === 'routine');
  if (state.filter === 'troubleshooting') list = list.filter((c) => c.type === 'troubleshooting');
  if (state.filter === 'loose-only') list = list.filter((c) => c.looseReady && !c.strictReady && !c.released);

  const box = $('#cards');
  if (!list.length) { box.innerHTML = '<p class="muted">没有符合筛选条件的工卡。</p>'; return; }
  box.innerHTML = list.map((c) => {
    const pct = Math.round((c.doneSteps / c.totalSteps) * 100);
    let badge;
    if (c.released) badge = '<span class="badge released">● 已完工放行</span>';
    else if (c.strictReady) badge = '<span class="badge strict-ready">严格口径可放行</span>';
    else if (c.looseReady) badge = '<span class="badge loose-only">仅步骤签完（保留项/资质仍拦）</span>';
    else badge = '<span class="badge blocked">执行中 / 不可放行</span>';
    const flags = [];
    if (c.hasOverdueReview) flags.push('<span class="badge overdue">复查超期</span>');
    if (c.hasDueTodayReview) flags.push('<span class="badge due">今日到期复查</span>');
    if (c.openPartRetains) flags.push(`<span class="badge part">缺件保留 ${c.openPartRetains}</span>`);
    return `
      <div class="card" data-card="${esc(c.cardNo)}">
        <h3>${esc(c.cardNo)} ｜ ${esc(c.title)}</h3>
        <div class="meta">
          <span class="chip">${esc(c.aircraft)}</span>
          <span class="chip">${esc(c.trade)}</span>
          <span class="chip type-${c.type}">${c.type === 'routine' ? '例行' : '排故'}</span>
          <span class="chip">计划完工 ${esc(c.plannedFinishText)}</span>
        </div>
        <div class="progress"><div style="width:${pct}%"></div></div>
        <div class="status-line">
          <span>${c.doneSteps}/${c.totalSteps} 步闭合</span>
          ${badge}
          ${flags.join(' ')}
        </div>
      </div>`;
  }).join('');
  $$('#cards .card').forEach((el) => el.addEventListener('click', () => go('cards/' + el.dataset.card)));
}

// ---------------------------------------------------------------------------
// 人员与资质面板
// ---------------------------------------------------------------------------

async function renderStaff(view) {
  const data = await api('/api/staff');
  view.innerHTML = `
    <p class="muted">今天 ${esc(data.asOf)}。签字时后端按“人员是否持有该工种资质条目 + 证件未到期”实时校验；
    没有对应工种条目的签名一律拒绝，并指出缺的是哪一条资质。</p>
    <div class="two-col">
      <div class="panel"><h3>工种（${data.trades.length}）</h3>
        ${data.trades.map((t) => `<div class="qual" style="font-size:13px;padding:5px 12px;margin-bottom:6px">${esc(t.code)} — ${esc(t.name)}</div>`).join('')}
      </div>
      <div>
        ${data.staff.map((p) => {
          const quals = p.qualifications.map((q) => {
            const expired = q.certExpires && q.certExpires < data.asOf;
            return `<span class="qual ${expired ? 'expired' : ''}">${esc(q.trade)} ｜ ${esc(q.certNo)} ｜ 有效期至 ${esc(q.certExpires)}${expired ? '（已到期）' : ''}</span>`;
          }).join('');
          return `<div class="staff-card">
            <div><span class="name">${esc(p.staffId)} ${esc(p.name)}</span> <span class="team">${esc(p.team)}</span></div>
            <div>${quals}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// 保留项台账 + 库房
// ---------------------------------------------------------------------------

const RETAIN_META = {
  overdue: ['overdue', '复查超期'],
  'due-today': ['due', '今日到期复查'],
  'awaiting-part': ['part', '缺件等件中'],
  'in-date': ['indate', '复查在期内'],
  closed: ['closed', '已关闭'],
};

async function renderRetains(view) {
  const data = await api('/api/retains');
  view.innerHTML = `
    <div class="toolbar">
      <label>筛选：</label>
      <select id="rf">
        <option value="all">全部保留项</option>
        <option value="open">未关闭</option>
        <option value="review">复查类</option>
        <option value="part">缺件类</option>
        <option value="overdue">超期复查</option>
        <option value="due-today">今日到期复查</option>
      </select>
      <span class="muted">今天 ${esc(data.asOf)}</span>
    </div>
    <div class="panel" style="margin-bottom:14px"><h3>保留项台账</h3>
      <table class="grid">
        <thead><tr><th>编号</th><th>类型/状态</th><th>工卡</th><th>内容</th><th>关键日期/物料</th><th>操作</th></tr></thead>
        <tbody id="retain-rows"></tbody>
      </table>
    </div>
    <div class="panel"><h3>库房台账（实时余量，由签字事件流重放）</h3>
      <table class="grid">
        <thead><tr><th>物料码</th><th>名称</th><th>单位</th><th>期初</th><th>当前余量</th></tr></thead>
        <tbody>
          ${data.inventory.map((i) => `<tr${i.qty <= 0 ? ' style="color:#ff9f9f"' : ''}>
            <td>${esc(i.code)}</td><td>${esc(i.name)}</td><td>${esc(i.unit)}</td>
            <td>${i.initialQty}</td><td><b>${i.qty}</b></td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  const drawRows = (filter) => {
    let list = data.retains;
    if (filter === 'open') list = list.filter((r) => r.status !== 'closed');
    if (filter === 'review') list = list.filter((r) => r.kind === 'review');
    if (filter === 'part') list = list.filter((r) => r.kind === 'part');
    if (filter === 'overdue') list = list.filter((r) => r.retainState === 'overdue');
    if (filter === 'due-today') list = list.filter((r) => r.retainState === 'due-today');
    $('#retain-rows').innerHTML = list.map((r) => {
      const [cls, label] = RETAIN_META[r.retainState];
      const action = r.status === 'closed'
        ? `<span class="muted">${esc(r.closedReason || '')}${r.closedAtText ? '（' + esc(r.closedAtText) + '）' : ''}</span>`
        : r.kind === 'part'
          ? `<button class="btn ghost" data-act="arrived" data-id="${esc(r.id)}">登记到货入库</button>`
          : `<button class="btn ghost" data-act="reviewed" data-id="${esc(r.id)}">登记复查完成</button>`;
      return `<tr>
        <td>${esc(r.id)}</td>
        <td>${r.kind === 'part' ? '缺件等件' : '到期复查'}<br><span class="badge ${cls}">${label}</span></td>
        <td>${esc(r.cardNo)}<br><span class="muted">${esc(r.aircraft || '')}</span></td>
        <td>${esc(r.title)}<br><span class="muted">${esc(r.detail || '')}</span></td>
        <td>${r.kind === 'part'
          ? `阻塞步骤 ${esc(r.stepNo)}<br><span class="muted">${esc(r.materialCode)} 台账余量 ${r.stockQty ?? '-'}</span>`
          : `应复查日期 <b>${esc(r.dueDate)}</b>`}</td>
        <td>${action}</td>
      </tr>`;
    }).join('');
  };
  drawRows('all');
  $('#rf').addEventListener('change', (e) => drawRows(e.target.value));

  $('#retain-rows').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      if (btn.dataset.act === 'arrived') {
        const staffId = pickStaff('登记到货的办理人：', null);
        if (!staffId) return;
        const qty = Number(prompt('到货数量：', '1'));
        if (!qty || qty <= 0) return;
        const grn = prompt('入库单号（可留空）：', '') || '';
        await api('/api/retains/arrived', { method: 'POST', body: { retainId: id, staffId, qty, grn } });
        toast('缺件已到货入库，保留项关闭，对应步骤解除拦截', 'ok');
      } else {
        const staffId = pickStaff('复查签署人（需工卡专业资质或放行授权）：', null);
        if (!staffId) return;
        const result = prompt('复查结论：', '复查合格，指示正常') || '复查合格';
        await api('/api/retains/reviewed', { method: 'POST', body: { retainId: id, staffId, result } });
        toast('复查已登记，保留项关闭', 'ok');
      }
      render();
    } catch (err) {
      toast('操作被拒绝：' + err.message, 'error');
    }
  });
}

// ---------------------------------------------------------------------------
// 签字记录（只往下滚，不改旧记录）
// ---------------------------------------------------------------------------

async function renderLog(view) {
  const no = state.logCardNo;
  const data = await api('/api/events' + (no ? '?cardNo=' + encodeURIComponent(no) : ''));
  view.innerHTML = `
    <div class="toolbar">
      <label>工卡：</label>
      <select id="log-card">
        <option value="">全部事件</option>
        ${(await api('/api/overview')).cards.map((c) =>
          `<option value="${esc(c.cardNo)}" ${c.cardNo === no ? 'selected' : ''}>${esc(c.cardNo)}</option>`).join('')}
      </select>
      <span class="muted">共 ${data.total} 条事件，新事件只追加在最下面（冲正也不改旧行，只追加 correction 回链）</span>
    </div>
    <div class="log" id="log-box"></div>
    <div class="danger-zone">
      <button class="btn danger" id="reset">清空事件流恢复样例（自动备份）</button>
    </div>`;

  drawLog(data.events);
  $('#log-card').addEventListener('change', (e) => {
    const v = e.target.value;
    location.hash = v ? '#/log/' + v : '#/log';
  });
  $('#reset').addEventListener('click', async () => {
    if (!confirm('确定清空 data/events.jsonl？旧文件会自动备份。')) return;
    try {
      const r = await api('/api/reset', { method: 'POST', body: {} });
      toast(r.message, 'ok');
      state.cardNo = null;
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function drawLog(events) {
  const box = $('#log-box');
  if (!events.length) { box.innerHTML = '<span class="muted">还没有任何签字事件。</span>'; return; }
  box.innerHTML = events.map((ev) => {
    const cls = ev.type === 'correction' ? 'ev-correction'
      : ev.type === 'release' ? 'ev-release'
      : ev.type.startsWith('retain') ? 'ev-retain'
      : ev.type === 'skip' || ev.type === 'unskip' ? 'ev-skip'
      : 'ev-sign';
    return `<span class="${cls}">[${esc(ev.atText)}] ${esc(ev.id)} ${esc(JSON.stringify(compactEvent(ev)))}</span>`;
  }).join('\n');
  box.scrollTop = box.scrollHeight;
}

function compactEvent(ev) {
  const e = { ...ev };
  delete e.at; delete e.atText;
  return e;
}

// ---------------------------------------------------------------------------
// 单份工卡：步骤树 + 时间线 + 放行
// ---------------------------------------------------------------------------

async function renderCard(view) {
  const card = await api('/api/cards?cardNo=' + encodeURIComponent(state.cardNo));

  const typeText = card.type === 'routine' ? '例行' : '排故';
  const retainBadges = card.retains.map((r) => {
    const [cls, label] = RETAIN_META[r.retainState];
    return `<span class="badge ${cls}">${esc(r.id)} ${label}</span>`;
  }).join(' ');

  view.innerHTML = `
    <button class="btn ghost back" id="back">← 返回工卡列表</button>
    <div class="card-head">
      <h2>${esc(card.cardNo)} ｜ ${esc(card.title)}</h2>
      <div class="meta">
        <span class="chip">${esc(card.aircraft)}</span>
        <span class="chip">${esc(card.trade)}</span>
        <span class="chip type-${card.type}">${typeText}</span>
        <span class="chip">计划完工 ${esc(card.plannedFinishText)}</span>
        ${retainBadges}
      </div>
      <div id="release-slot"></div>
    </div>
    <div class="layout">
      <div class="panel">
        <h3>步骤树（前置未完成的步骤置灰；绿色已签、黄色待双人会签、虚线为排故跳过）</h3>
        <ol class="steps" id="steps">
          ${card.steps.map((s) => stepHtml(card, s)).join('')}
        </ol>
      </div>
      <div class="panel">
        <h3>执行时间线（点开看谁在什么时候签的）</h3>
        <ul class="timeline">
          ${card.timeline.length ? card.timeline.map((t) => `
            <li class="${esc(t.kind)}">
              <div class="t-time">${esc(t.atText)}${t.stepNo ? ` ｜ 步骤 ${t.stepNo}` : ''}</div>
              <div class="t-text">${esc(t.text)}</div>
            </li>`).join('') : '<li class="muted">暂无执行事件</li>'}
        </ul>
      </div>
    </div>`;

  $('#back').addEventListener('click', () => go('cards'));
  bindStepActions(card);
  drawRelease(card);
}

function stepHtml(card, s) {
  const locked = s.status === 'locked';
  const dualTag = s.requiresDual ? '<span class="chip">双人签</span>' : '';
  const skipTag = s.skippable ? '<span class="chip">排故可跳过</span>' : '';
  const mats = (s.materials || []).map((m) => `${esc(m.name)} ×${m.qty}`).join('，');
  const depText = (s.dependsOn || []).length
    ? `前置步骤：${s.dependsOn.join('、')}`
    : '起始步骤，无前置';

  let signers = '';
  if (s.record) {
    const r = s.record;
    const lines = r.signatures.map((sig, i) => {
      const cls = r.voided ? 'voided-sig' : 'sig';
      const who = r.dual ? (i === 0 ? '第一签署人' : '第二签署人') : '签署人';
      return `<div class="${cls}">${who}：${esc(sig.staffName)}（${esc(sig.staffId)}） ${esc(sig.atText)}</div>`;
    }).join('');
    const used = (r.materials || []).map((m) => `${esc(m.name)} ×${m.qty}`).join('，');
    signers = `<div class="signers">${lines}` +
      (used && !r.voided ? `<div class="muted">耗材扣减：${used}</div>` : '') +
      (r.voided ? `<div class="correction">已被冲正 ${esc(r.correctionId)}：${esc(r.voidReason)}（${esc(r.voidBy)} ${esc(r.voidAtText)}），原记录保留不可改</div>` : '') +
      `</div>`;
  }

  let skipNote = '';
  if (s.skip && !s.skip.voided) {
    skipNote = `<div class="skip-note">已排故跳过｜原因：${esc(s.skip.reason)}｜批准人：${esc(s.skip.approverName)}（${esc(s.skip.atText)}）</div>`;
  }
  const partWarn = (s.partBlocking || []).map((r) =>
    `<div class="part-warn">⛔ 缺件保留项 ${esc(r.id)}：${esc(r.title)}，件到前本步禁止签署</div>`).join('');

  let actions = '';
  if (!card.released) {
    if (s.status === 'skipped') {
      actions = `<button class="btn ghost" data-act="unskip">撤销跳过（放行人员）</button>`;
    } else if (s.status === 'signed') {
      actions = `<button class="btn danger" data-act="correct">冲正这条签字</button>`;
    } else if (s.status === 'partial') {
      actions = `<button class="btn" data-act="sign">第二人会签</button>
        <button class="btn danger" data-act="correct">冲正第一签</button>
        <span class="muted">缺一人会签不算完成，耗材尚未扣减</span>`;
    } else if (s.status === 'ready') {
      const signLabel = s.requiresDual ? '第一签署' : '签字';
      actions = `<button class="btn" data-act="sign">${signLabel}</button>`;
      if (s.skippable) actions += `<button class="btn ghost" data-act="skip">排故跳过</button>`;
    } else {
      actions = `<span class="muted">前置步骤未闭合，本步禁止签署</span>`;
    }
  }

  return `<li class="step ${s.status}" data-step="${s.stepNo}">
    <div class="step-top">
      <div class="step-no">${s.stepNo}</div>
      <div class="step-content">${esc(s.content)}<span class="trade">工种：${esc(s.trade)}</span>${dualTag}${skipTag}</div>
    </div>
    <div class="step-deps">${depText}</div>
    ${mats ? `<div class="step-mats">耗材：${mats}</div>` : ''}
    ${partWarn}
    ${signers}
    ${skipNote}
    <div class="step-actions">${actions}</div>
  </li>`;
}

function drawRelease(card) {
  const slot = $('#release-slot');
  if (card.released) {
    slot.innerHTML = `<div class="release-bar">
      <span class="badge released">● 已按严格口径完工放行</span>
      <span class="muted">放行签署人：${esc(card.releaseBy)} ｜ ${esc(card.releasedAtText)}</span>
    </div>`;
    return;
  }

  const reasons = [];
  if (card.blockers.steps.length) reasons.push(...card.blockers.steps.map((x) => '步骤：' + x));
  if (card.blockers.parts.length) reasons.push(...card.blockers.parts.map((x) => '缺件：' + x));
  if (card.blockers.reviews.length) reasons.push(...card.blockers.reviews.map((x) => '复查：' + x));
  if (card.blockers.qualifications.length) reasons.push(...card.blockers.qualifications.map((x) => '资质：' + x));

  slot.innerHTML = `<div class="release-bar">
      <button class="btn" id="do-release" ${card.strictReady ? '' : 'disabled title="不满足严格放行条件"'}>
        报完工 / 放行（严格口径）
      </button>
      <span class="muted">${card.strictReady
        ? '已满足：全部步骤闭合、缺件保留项关闭、复查不超期、资质全部对得上'
        : '完工按钮已置灰，原因见下（或仅“步骤签完”也不允许放行）'}</span>
    </div>
    ${reasons.length ? `<div class="blockers">不允许完工的原因：\n- ${reasons.map(esc).join('\n- ')}</div>` : ''}`;

  if (card.strictReady) {
    $('#do-release').addEventListener('click', async () => {
      const staffId = pickStaff('选择放行签署人（需「放行」授权）：', '放行');
      if (!staffId) return;
      try {
        const r = await api('/api/release', { method: 'POST', body: { cardNo: card.cardNo, staffId } });
        toast(r.message, 'ok');
        render();
      } catch (err) {
        toast('放行被拒绝：' + err.message, 'error');
      }
    });
  }
}

function bindStepActions(card) {
  $('#steps').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const li = btn.closest('li.step');
    const stepNo = Number(li.dataset.step);
    const step = card.steps.find((x) => x.stepNo === stepNo);
    const act = btn.dataset.act;
    try {
      if (act === 'sign') {
        const allowUnqualified = confirm(
          '【签字人选择】\n\n确定 = 从持本步骤工种资质的人员中选择（正常流程）\n' +
          '取消 = 从全部人员中选择，可故意选一名没有该工种资质的人，以验证后端拒绝并指出缺哪条资质');
        const staffId = pickStaff(
          `步骤 ${stepNo}（需要「${step.trade}」工种${step.requiresDual ? '，双人签' : ''}）选择签署人：`,
          step.trade,
          { allowAny: !allowUnqualified }
        );
        if (!staffId) return;
        const r = await api('/api/sign', { method: 'POST', body: { cardNo: card.cardNo, stepNo, staffId } });
        toast(r.message, 'ok');
      } else if (act === 'correct') {
        const recId = step.record ? step.record.recordId : null;
        if (!recId) return;
        const staffId = pickStaff('冲正操作人（原签署人本人或放行授权人员）：', '放行', { allowAny: true });
        if (!staffId) return;
        const reason = prompt('冲正原因（旧记录不可改，将追加一条冲正并回链原记录）：', '');
        if (!reason) return;
        const r = await api('/api/correct', { method: 'POST', body: { cardNo: card.cardNo, stepNo, recordId: recId, staffId, reason } });
        toast(r.message, 'ok');
      } else if (act === 'skip') {
        const approverId = pickStaff('选择跳过批准人（须「放行」授权）：', '放行');
        if (!approverId) return;
        const reason = prompt('跳过原因（必填）：', '该项经检查状态正常，按排故方案无需执行');
        if (!reason) return;
        const r = await api('/api/skip', { method: 'POST', body: { cardNo: card.cardNo, stepNo, approverId, reason } });
        toast(r.message, 'ok');
      } else if (act === 'unskip') {
        const approverId = pickStaff('选择撤销跳过的放行人员：', '放行');
        if (!approverId) return;
        const r = await api('/api/unskip', { method: 'POST', body: { cardNo: card.cardNo, stepNo, approverId } });
        toast(r.message, 'ok');
      }
      render();
    } catch (err) {
      toast('操作被拒绝：' + err.message, 'error');
    }
  });
}

render();
