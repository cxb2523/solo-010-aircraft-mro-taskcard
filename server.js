'use strict';

/**
 * 航空机务工卡执行与放行台子 —— Node 20 零依赖后端
 * 仅使用 node: 内置模块（http/fs/path/crypto）。
 *
 * 设计要点：
 *  - 基础台账：data/cards.json、data/deps.json、data/staff.json（每次请求现读，改复查日期即时生效）
 *  - 运行态：data/events.jsonl 只追加的签字事件流；冲正不改旧记录，只追加 correction 事件并回链原记录
 *  - 所有运行状态（签署/跳过/保留项关闭/库存/完工）都由事件流重放得到
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CARDS_FILE = path.join(DATA_DIR, 'cards.json');
const DEPS_FILE = path.join(DATA_DIR, 'deps.json');
const STAFF_FILE = path.join(DATA_DIR, 'staff.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT) || 8080;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

/** 按 UTC+8 给出本地 YYYY-MM-DD，保证演示与 Asia/Shanghai 一致 */
function todayDate(d = new Date()) {
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000).toISOString().slice(0, 10);
}

/** 把事件时刻转成 UTC+8 的可读字符串 */
function fmtTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${bj.getFullYear()}-${p(bj.getMonth() + 1)}-${p(bj.getDate())} ` +
    `${p(bj.getHours())}:${p(bj.getMinutes())}:${p(bj.getSeconds())}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

// ---------------------------------------------------------------------------
// 基础台账加载（含依赖一致性校验）
// ---------------------------------------------------------------------------

function loadBase() {
  const cardsDoc = readJson(CARDS_FILE);
  const depsDoc = readJson(DEPS_FILE);
  const staffDoc = readJson(STAFF_FILE);

  const depMap = new Map();
  for (const block of depsDoc.dependencies) {
    const m = new Map();
    for (const e of block.edges) m.set(e.step, [...e.dependsOn]);
    depMap.set(block.cardNo, m);
  }

  for (const card of cardsDoc.cards) {
    const m = depMap.get(card.cardNo);
    if (!m) throw new Error(`deps.json 缺少工卡 ${card.cardNo} 的依赖块`);
    for (const step of card.steps) {
      const authoritative = (m.get(step.stepNo) || []).slice().sort((a, b) => a - b);
      const inline = [...(step.dependsOn || [])].sort((a, b) => a - b);
      if (JSON.stringify(authoritative) !== JSON.stringify(inline)) {
        throw new Error(`工卡 ${card.cardNo} 步骤 ${step.stepNo} 的 dependsOn 与 deps.json 不一致`);
      }
    }
  }

  return {
    cards: cardsDoc.cards,
    retainsBase: depsDoc.retains,
    inventoryBase: depsDoc.inventory,
    trades: staffDoc.trades,
    staff: staffDoc.staff,
  };
}

function findCard(base, cardNo) {
  const card = base.cards.find((c) => c.cardNo === cardNo);
  if (!card) throw new HttpError(404, 'card_not_found', `工卡 ${cardNo} 不存在`);
  return card;
}

function findStep(card, stepNo) {
  const n = Number(stepNo);
  const step = card.steps.find((s) => s.stepNo === n);
  if (!step) throw new HttpError(404, 'step_not_found', `工卡 ${card.cardNo} 没有步骤 ${stepNo}`);
  return step;
}

function findStaff(base, staffId) {
  const person = base.staff.find((s) => s.staffId === staffId);
  if (!person) throw new HttpError(404, 'staff_not_found', `人员 ${staffId} 不存在`);
  return person;
}

// ---------------------------------------------------------------------------
// 事件流（只追加）与状态重放
// ---------------------------------------------------------------------------

function ensureEventsFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, '', 'utf8');
}

function readEvents() {
  ensureEventsFile();
  const events = [];
  for (const line of fs.readFileSync(EVENTS_FILE, 'utf8').split('\n')) {
    const t = line.trim();
    if (t) events.push(JSON.parse(t));
  }
  return events;
}

function appendEvent(event) {
  ensureEventsFile();
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n', 'utf8');
  return event;
}

function nextEventId(events) {
  return 'EVT-' + String(events.length + 1).padStart(5, '0');
}

/**
 * 由基础台账 + 事件流重放运行态。
 * 记录（records）以 cardNo#stepNo 为键；冲正 voided 后该步骤重新可签。
 * 库存从库房期初数量按“记录完成扣减 / 冲正回补”重放。
 */
function buildState(base, events) {
  const records = new Map();
  const recordById = new Map();
  const skips = new Map();
  const retains = new Map();
  const released = new Map();
  const stock = new Map();

  for (const item of base.inventoryBase) stock.set(item.code, item.qty);
  for (const r of base.retainsBase) retains.set(r.id, { ...r });

  const keyOf = (cardNo, stepNo) => `${cardNo}#${stepNo}`;

  for (const ev of events) {
    switch (ev.type) {
      case 'sign': {
        const key = keyOf(ev.cardNo, ev.stepNo);
        if (ev.dual) {
          if (ev.stage === 'first') {
            const rec = {
              id: ev.recordId, cardNo: ev.cardNo, stepNo: ev.stepNo, dual: true,
              complete: false, voided: false,
              signatures: [{ staffId: ev.staffId, staffName: ev.staffName, at: ev.at }],
              materials: ev.materials, events: [ev.id],
            };
            records.set(key, rec);
            recordById.set(rec.id, rec);
          } else if (ev.stage === 'second') {
            const rec = records.get(key);
            if (rec && !rec.voided) {
              rec.signatures.push({ staffId: ev.staffId, staffName: ev.staffName, at: ev.at });
              rec.complete = true;
              rec.events.push(ev.id);
              for (const m of rec.materials) stock.set(m.code, (stock.get(m.code) || 0) - m.qty);
            }
          }
        } else {
          const rec = {
            id: ev.recordId, cardNo: ev.cardNo, stepNo: ev.stepNo, dual: false,
            complete: true, voided: false,
            signatures: [{ staffId: ev.staffId, staffName: ev.staffName, at: ev.at }],
            materials: ev.materials, events: [ev.id],
          };
          records.set(key, rec);
          recordById.set(rec.id, rec);
          for (const m of rec.materials) stock.set(m.code, (stock.get(m.code) || 0) - m.qty);
        }
        break;
      }
      case 'correction': {
        const rec = recordById.get(ev.recordId);
        if (rec && !rec.voided) {
          rec.voided = true;
          rec.voidReason = ev.reason;
          rec.voidBy = ev.staffName;
          rec.voidAt = ev.at;
          rec.correctionId = ev.id;
          if (rec.complete) {
            for (const m of rec.materials) stock.set(m.code, (stock.get(m.code) || 0) + m.qty);
          }
          if (records.get(keyOf(rec.cardNo, rec.stepNo)) === rec) {
            records.delete(keyOf(rec.cardNo, rec.stepNo));
          }
        }
        break;
      }
      case 'skip': {
        skips.set(keyOf(ev.cardNo, ev.stepNo), {
          reason: ev.reason, approverId: ev.approverId, approverName: ev.approverName,
          at: ev.at, voided: false,
        });
        break;
      }
      case 'unskip': {
        const sk = skips.get(keyOf(ev.cardNo, ev.stepNo));
        if (sk) sk.voided = true;
        break;
      }
      case 'retain_arrived': {
        const r = retains.get(ev.retainId);
        if (r) {
          r.status = 'closed';
          r.closedReason = `缺件到货（${ev.grn || '入库单'}，数量 ${ev.qty}）`;
          r.closedBy = ev.staffName;
          r.closedAt = ev.at;
        }
        for (const m of ev.materials || []) stock.set(m.code, (stock.get(m.code) || 0) + m.qty);
        break;
      }
      case 'retain_reviewed': {
        const r = retains.get(ev.retainId);
        if (r) {
          r.status = 'closed';
          r.closedReason = `到期复查完成：${ev.result || '复查合格'}`;
          r.closedBy = ev.staffName;
          r.closedAt = ev.at;
        }
        break;
      }
      case 'retain_close': {
        const r = retains.get(ev.retainId);
        if (r) {
          r.status = 'closed';
          r.closedReason = ev.reason || '人工关闭';
          r.closedBy = ev.staffName;
          r.closedAt = ev.at;
        }
        break;
      }
      case 'release': {
        released.set(ev.cardNo, ev);
        break;
      }
      default:
        break;
    }
  }

  return { records, recordById, skips, retains, released, stock };
}

// ---------------------------------------------------------------------------
// 资质判定
// ---------------------------------------------------------------------------

function qualEntry(person, trade) {
  return (person.qualifications || []).find((q) => q.trade === trade);
}

function assertQualified(base, person, trade, ctx) {
  const q = qualEntry(person, trade);
  if (!q) {
    throw new HttpError(
      403, 'qualification_missing',
      `${ctx}被拒绝：人员 ${person.name}（${person.staffId}）的资质台账中没有「${trade}」工种条目，` +
      `不满足该步骤要求的「${trade}」资质（资质要求条目：trade=${trade}）`
    );
  }
  const today = todayDate();
  if (q.certExpires && q.certExpires < today) {
    throw new HttpError(
      403, 'certificate_expired',
      `${ctx}被拒绝：人员 ${person.name} 的「${trade}」资质证件 ${q.certNo} 已于 ${q.certExpires} 到期` +
      `（今天 ${today}），不满足该条资质要求`
    );
  }
  return q;
}

// ---------------------------------------------------------------------------
// 步骤 / 工卡状态计算
// ---------------------------------------------------------------------------

function stepStatus(card, step, state) {
  const key = `${card.cardNo}#${step.stepNo}`;
  const rec = state.records.get(key);
  const skip = state.skips.get(key);
  if (rec && !rec.voided) return rec.complete ? 'signed' : 'partial';
  if (skip && !skip.voided) return 'skipped';

  for (const dep of step.dependsOn || []) {
    const dk = `${card.cardNo}#${dep}`;
    const dr = state.records.get(dk);
    const ds = state.skips.get(dk);
    const depOk = (dr && !dr.voided && dr.complete) || (ds && !ds.voided);
    if (!depOk) return 'locked';
  }
  return 'ready';
}

function cardRetains(card, state) {
  return [...state.retains.values()].filter((r) => r.cardNo === card.cardNo);
}

/** closed | overdue | due-today | in-date | awaiting-part */
function retainState(r, asOf) {
  if (r.status === 'closed') return 'closed';
  if (r.kind === 'review') {
    if (r.dueDate < asOf) return 'overdue';
    if (r.dueDate === asOf) return 'due-today';
    return 'in-date';
  }
  return 'awaiting-part';
}

/**
 * 评估工卡放行。
 * loose（宽松口径）：所有非跳过步骤签完即可，不管保留项。
 * strict（本系统采用的口径）：
 *   1) 每个步骤要么签署完成、要么经批准合规跳过；
 *   2) 缺件类保留项全部关闭（缺件未到不得放行）；
 *   3) 复查类保留项不处于超期状态（到期当天允许，超期整份不许完工）；
 *   4) 每条已完成签字的签署人都仍持有对应有效资质。
 */
function evaluateCard(base, card, state, asOf) {
  const stepResults = card.steps.map((step) => {
    const status = stepStatus(card, step, state);
    return { step, status };
  });

  const stepBlockers = [];
  for (const { step, status } of stepResults) {
    if (status === 'locked') {
      const missing = (step.dependsOn || [])
        .filter((dep) => {
          const dr = state.records.get(`${card.cardNo}#${dep}`);
          const ds = state.skips.get(`${card.cardNo}#${dep}`);
          return !((dr && !dr.voided && dr.complete) || (ds && !ds.voided));
        });
      stepBlockers.push(`步骤 ${step.stepNo} 的前置步骤未完成：${missing.join('、') || '存在未闭合前置'}`);
    }
  }

  const unsigned = stepResults
    .filter((x) => x.status !== 'signed' && x.status !== 'skipped')
    .map((x) => x.step.stepNo);
  if (unsigned.length) {
    stepBlockers.push(`仍有步骤未签署/未跳过：${unsigned.join('、')}`);
  }

  const partBlockers = [];
  const reviewBlockers = [];
  for (const r of cardRetains(card, state)) {
    const rs = retainState(r, asOf);
    if (rs === 'awaiting-part') {
      partBlockers.push(`缺件保留项 ${r.id} 未关闭：${r.title}（阻塞步骤 ${r.stepNo}）`);
    }
    if (rs === 'overdue') {
      reviewBlockers.push(`复查保留项 ${r.id} 已超期：${r.title}（应于 ${r.dueDate} 前复查）`);
    }
  }

  const qualBlockers = [];
  for (const [, rec] of state.records) {
    if (rec.voided || rec.cardNo !== card.cardNo) continue;
    const step = card.steps.find((s) => s.stepNo === rec.stepNo);
    if (!step) continue;
    for (const sig of rec.signatures) {
      const person = base.staff.find((p) => p.staffId === sig.staffId);
      if (!person) {
        qualBlockers.push(`步骤 ${step.stepNo} 的签署人 ${sig.staffId} 已不在人员台账`);
        continue;
      }
      const q = qualEntry(person, step.trade);
      if (!q) qualBlockers.push(`步骤 ${step.stepNo} 签署人 ${person.name} 缺少「${step.trade}」资质条目`);
      else if (q.certExpires && q.certExpires < asOf) {
        qualBlockers.push(`步骤 ${step.stepNo} 签署人 ${person.name} 的「${step.trade}」证件 ${q.certNo} 已到期`);
      }
    }
  }

  const looseReady = stepBlockers.length === 0;
  const strictBlockers = [...stepBlockers, ...partBlockers, ...reviewBlockers, ...qualBlockers];
  const strictReady = strictBlockers.length === 0;

  return {
    stepResults,
    looseReady,
    strictReady,
    blockers: {
      steps: stepBlockers,
      parts: partBlockers,
      reviews: reviewBlockers,
      qualifications: qualBlockers,
      all: strictBlockers,
    },
    released: !!state.released.get(card.cardNo),
  };
}

// ---------------------------------------------------------------------------
// 业务动作
// ---------------------------------------------------------------------------

function loadContext() {
  const base = loadBase();
  const events = readEvents();
  const state = buildState(base, events);
  const asOf = todayDate();
  return { base, events, state, asOf };
}

function stockSummary(base, state) {
  return base.inventoryBase.map((item) => ({
    code: item.code,
    name: item.name,
    unit: item.unit,
    initialQty: item.qty,
    qty: state.stock.get(item.code) ?? item.qty,
  }));
}

function handleSign(base, events, state, body, asOf) {
  const card = findCard(base, body.cardNo);
  const step = findStep(card, body.stepNo);
  const person = findStaff(base, body.staffId);
  const ctx = `工卡 ${card.cardNo} 步骤 ${step.stepNo} 签字`;

  if (state.released.get(card.cardNo)) {
    throw new HttpError(409, 'card_released', `工卡 ${card.cardNo} 已报完工放行，不能再补签；如需改动请先冲正相关记录`);
  }

  const key = `${card.cardNo}#${step.stepNo}`;
  const skip = state.skips.get(key);
  if (skip && !skip.voided) {
    throw new HttpError(409, 'step_skipped', `步骤 ${step.stepNo} 已按排故跳过；如需执行请先由放行人员撤销跳过`);
  }

  const existing = state.records.get(key);
  if (existing && !existing.voided) {
    if (!step.requiresDual || existing.complete) {
      throw new HttpError(409, 'already_signed', `步骤 ${step.stepNo} 已签署完成，签字记录只许追加；写错请走“冲正”后重签`);
    }
  }

  // 资质（每次签署实时校验）
  assertQualified(base, person, step.trade, ctx);

  // 依赖顺序放行
  const missingDeps = (step.dependsOn || []).filter((dep) => {
    const dr = state.records.get(`${card.cardNo}#${dep}`);
    const ds = state.skips.get(`${card.cardNo}#${dep}`);
    return !((dr && !dr.voided && dr.complete) || (ds && !ds.voided));
  });
  if (missingDeps.length) {
    throw new HttpError(
      409, 'dependency_not_signed',
      `前置步骤没签就想签后面的，已拒绝：步骤 ${step.stepNo} 缺少前置步骤 ${missingDeps.join('、')} 的有效签署` +
      `（跳过的排故步骤须有批准记录才算完成）`
    );
  }

  // 缺件保留项拦截
  const blockingRetains = [...state.retains.values()].filter(
    (r) => r.cardNo === card.cardNo && r.status === 'open' &&
      r.kind === 'part' && Number(r.stepNo) === Number(step.stepNo)
  );
  if (blockingRetains.length) {
    throw new HttpError(
      409, 'part_retain_open',
      `缺件没到不能签这一步：保留项 ${blockingRetains.map((r) => r.id).join('、')} 仍开放（${blockingRetains[0].title}），` +
      `须先办理到货入库关闭保留项`
    );
  }

  const materials = (step.materials || []).map((m) => ({ code: m.code, name: m.name, qty: m.qty }));

  if (step.requiresDual) {
    if (existing && !existing.voided && !existing.complete) {
      // 第二个签署人
      const first = existing.signatures[0];
      if (first.staffId === person.staffId) {
        throw new HttpError(409, 'dual_same_person', `双人签步骤必须两个人分别签：${person.name} 已作为第一签署人签过，不能自己签第二下`);
      }
      // 第二签时校验库存并扣减
      assertStock(state, materials, step);
      const ev = {
        id: nextEventId(events), type: 'sign', at: nowIso(),
        cardNo: card.cardNo, stepNo: step.stepNo, staffId: person.staffId, staffName: person.name,
        trade: step.trade, dual: true, stage: 'second',
        recordId: existing.id, materials,
      };
      appendEvent(ev);
      return { ok: true, stage: 'second', recordId: existing.id, message: `双人签署完成（${first.staffName} + ${person.name}），耗材已从库房台账扣减` };
    }
    // 第一签署人：不扣库存（缺一个不算完）
    const recordId = 'REC-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const ev = {
      id: nextEventId(events), type: 'sign', at: nowIso(),
      cardNo: card.cardNo, stepNo: step.stepNo, staffId: person.staffId, staffName: person.name,
      trade: step.trade, dual: true, stage: 'first',
      recordId, materials,
    };
    appendEvent(ev);
    return { ok: true, stage: 'first', recordId, message: `第一签署人 ${person.name} 已签，等待第二名持「${step.trade}」资质人员会签` };
  }

  // 单人签：校验库存并扣减
  assertStock(state, materials, step);
  const recordId = 'REC-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  const ev = {
    id: nextEventId(events), type: 'sign', at: nowIso(),
    cardNo: card.cardNo, stepNo: step.stepNo, staffId: person.staffId, staffName: person.name,
    trade: step.trade, dual: false, recordId, materials,
  };
  appendEvent(ev);
  return { ok: true, stage: 'complete', recordId, message: `步骤 ${step.stepNo} 已由 ${person.name} 签署，耗材已从库房台账扣减` };
}

function assertStock(state, materials, step) {
  for (const m of materials) {
    const have = state.stock.get(m.code) ?? 0;
    if (have - m.qty < 0) {
      throw new HttpError(
        409, 'stock_insufficient',
        `耗材扣减会使库房台账变成负数，已拦截：步骤 ${step.stepNo} 需要 ${m.name}（${m.code}）${m.qty}，` +
        `当前台账仅剩 ${have}`
      );
    }
  }
}

function handleCorrect(base, events, state, body) {
  const card = findCard(base, body.cardNo);
  findStep(card, body.stepNo);
  const person = findStaff(base, body.staffId);
  const reason = String(body.reason || '').trim();
  if (!reason) throw new HttpError(400, 'reason_required', '冲正必须写明原因');

  const rec = state.recordById.get(body.recordId);
  if (!rec || rec.cardNo !== card.cardNo || rec.stepNo !== Number(body.stepNo)) {
    throw new HttpError(404, 'record_not_found', `工卡 ${card.cardNo} 步骤 ${body.stepNo} 下找不到签署记录 ${body.recordId}`);
  }
  if (rec.voided) {
    throw new HttpError(409, 'already_corrected', `记录 ${rec.recordId} 已被冲正记录 ${rec.correctionId} 指向，不能重复冲正`);
  }

  const isSigner = rec.signatures.some((s) => s.staffId === person.staffId);
  if (!isSigner) assertQualified(base, person, '放行', `冲正工卡 ${card.cardNo} 步骤 ${rec.stepNo} 的签字`);

  const ev = {
    id: nextEventId(events), type: 'correction', at: nowIso(),
    cardNo: card.cardNo, stepNo: rec.stepNo,
    recordId: rec.id, staffId: person.staffId, staffName: person.name, reason,
  };
  appendEvent(ev);
  return {
    ok: true,
    message: `已追加冲正事件 ${ev.id} 并指向原记录 ${rec.id}；旧记录保留不可改，该步骤恢复为可签状态` +
      (rec.complete ? '，已扣耗材按台账回补' : ''),
  };
}

function handleSkip(base, events, state, body, undo) {
  const card = findCard(base, body.cardNo);
  const step = findStep(card, body.stepNo);
  const approver = findStaff(base, body.approverId);
  const key = `${card.cardNo}#${step.stepNo}`;

  assertQualified(base, approver, '放行', undo ? `撤销步骤 ${step.stepNo} 跳过` : `批准步骤 ${step.stepNo} 跳过`);

  if (!undo) {
    if (card.type !== 'troubleshooting') {
      throw new HttpError(409, 'skip_not_allowed', '只有排故类工卡的步骤可以跳过；例行工卡步骤必须逐序签署');
    }
    if (!step.skippable) {
      throw new HttpError(409, 'step_not_skippable', `步骤 ${step.stepNo} 未标记为可跳过（关键步骤不得跳过）`);
    }
    const sk = state.skips.get(key);
    if (sk && !sk.voided) throw new HttpError(409, 'already_skipped', `步骤 ${step.stepNo} 已跳过`);
    const rec = state.records.get(key);
    if (rec && !rec.voided) throw new HttpError(409, 'step_signed', `步骤 ${step.stepNo} 已签署，不能跳过；如需跳过请先冲正签字`);
    const reason = String(body.reason || '').trim();
    if (!reason) throw new HttpError(400, 'reason_required', '跳过必须写明原因');
    const ev = {
      id: nextEventId(events), type: 'skip', at: nowIso(),
      cardNo: card.cardNo, stepNo: step.stepNo,
      reason, approverId: approver.staffId, approverName: approver.name,
    };
    appendEvent(ev);
    return { ok: true, message: `步骤 ${step.stepNo} 已按排故跳过，原因与批准人已记录` };
  }

  const sk = state.skips.get(key);
  if (!sk || sk.voided) throw new HttpError(409, 'not_skipped', `步骤 ${step.stepNo} 当前不是跳过状态`);
  const ev = {
    id: nextEventId(events), type: 'unskip', at: nowIso(),
    cardNo: card.cardNo, stepNo: step.stepNo,
    staffId: approver.staffId, staffName: approver.name,
  };
  appendEvent(ev);
  return { ok: true, message: `步骤 ${step.stepNo} 的跳过已由 ${approver.name} 撤销，恢复为待执行` };
}

function handleRetain(base, events, state, body, action) {
  const retain = state.retains.get(body.retainId);
  if (!retain) throw new HttpError(404, 'retain_not_found', `保留项 ${body.retainId} 不存在`);
  const person = findStaff(base, body.staffId);
  const card = findCard(base, retain.cardNo);

  if (retain.status === 'closed') {
    throw new HttpError(409, 'retain_closed', `保留项 ${retain.id} 已关闭（${retain.closedReason}）`);
  }

  if (action === 'arrived') {
    if (retain.kind !== 'part') throw new HttpError(409, 'wrong_kind', '到货入库仅适用于缺件类保留项');
    const qty = Math.max(1, Number(body.qty) || 1);
    const materials = [{ code: retain.materialCode, name: materialName(base, retain.materialCode), qty }];
    const ev = {
      id: nextEventId(events), type: 'retain_arrived', at: nowIso(),
      retainId: retain.id, staffId: person.staffId, staffName: person.name,
      grn: String(body.grn || `GRN-${Date.now()}`), qty, materials,
    };
    appendEvent(ev);
    return { ok: true, message: `缺件已到货入库 ${qty} 件，保留项 ${retain.id} 关闭，步骤 ${retain.stepNo} 解除拦截` };
  }

  if (action === 'reviewed') {
    if (retain.kind !== 'review') throw new HttpError(409, 'wrong_kind', '复查完成仅适用于到期复查类保留项');
    // 复查人须具备该工卡专业资质或放行授权
    const hasTrade = qualEntry(person, card.trade);
    const hasCert = qualEntry(person, '放行');
    if (!hasTrade && !hasCert) {
      throw new HttpError(
        403, 'qualification_missing',
        `复查被拒绝：${person.name} 既无本工卡专业「${card.trade}」资质，也无放行授权，不满足复查签署要求`
      );
    }
    const result = String(body.result || '').trim() || '复查合格，指示正常';
    const ev = {
      id: nextEventId(events), type: 'retain_reviewed', at: nowIso(),
      retainId: retain.id, staffId: person.staffId, staffName: person.name, result,
    };
    appendEvent(ev);
    return { ok: true, message: `复查已完成并关闭保留项 ${retain.id}` };
  }

  throw new HttpError(400, 'bad_action', `未知保留项动作 ${action}`);
}

function materialName(base, code) {
  const item = base.inventoryBase.find((i) => i.code === code);
  return item ? item.name : code;
}

function handleRelease(base, events, state, body, asOf) {
  const card = findCard(base, body.cardNo);
  const person = findStaff(base, body.staffId);
  assertQualified(base, person, '放行', `工卡 ${card.cardNo} 报完工放行`);

  const ev0 = evaluateCard(base, card, state, asOf);
  if (ev0.released) throw new HttpError(409, 'already_released', `工卡 ${card.cardNo} 已放行`);
  if (!ev0.strictReady) {
    throw new HttpError(409, 'release_blocked', `工卡不满足严格放行条件，已拒绝报完工：\n- ${ev0.blockers.all.join('\n- ')}`);
  }
  const ev = {
    id: nextEventId(events), type: 'release', at: nowIso(),
    cardNo: card.cardNo, staffId: person.staffId, staffName: person.name,
    policy: 'strict',
  };
  appendEvent(ev);
  return { ok: true, releasedAt: ev.at, message: `工卡 ${card.cardNo} 已按严格口径报完工放行，放行签署人 ${person.name}` };
}

function handleReset(events) {
  ensureEventsFile();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (fs.existsSync(EVENTS_FILE) && fs.statSync(EVENTS_FILE).size > 0) {
    fs.copyFileSync(EVENTS_FILE, path.join(DATA_DIR, `events.backup-${stamp}.jsonl`));
  }
  fs.writeFileSync(EVENTS_FILE, '', 'utf8');
  return { ok: true, message: '签字事件流已清空（旧文件已备份到 data 目录），样例恢复初始状态' };
}

// ---------------------------------------------------------------------------
// 输出视图
// ---------------------------------------------------------------------------

function recordView(rec) {
  return {
    recordId: rec.id,
    dual: rec.dual,
    complete: rec.complete,
    voided: rec.voided,
    signatures: rec.signatures.map((s) => ({ ...s, atText: fmtTs(s.at) })),
    materials: rec.materials,
    voidReason: rec.voidReason || null,
    voidBy: rec.voidBy || null,
    voidAtText: rec.voidAt ? fmtTs(rec.voidAt) : null,
    correctionId: rec.correctionId || null,
  };
}

function cardDetail(base, card, state, asOf, includeTimeline) {
  const ev = evaluateCard(base, card, state, asOf);
  const retains = cardRetains(card, state).map((r) => ({
    ...r,
    retainState: retainState(r, asOf),
    closedAtText: r.closedAt ? fmtTs(r.closedAt) : null,
  }));

  const steps = ev.stepResults.map(({ step, status }) => {
    const key = `${card.cardNo}#${step.stepNo}`;
    const rec = state.records.get(key);
    const skip = state.skips.get(key);
    const partBlocking = retains
      .filter((r) => r.kind === 'part' && Number(r.stepNo) === step.stepNo && r.status === 'open')
      .map((r) => ({ id: r.id, title: r.title }));

    const view = {
      stepNo: step.stepNo,
      content: step.content,
      trade: step.trade,
      requiresDual: !!step.requiresDual,
      skippable: !!step.skippable,
      dependsOn: step.dependsOn || [],
      materials: step.materials || [],
      status,
      record: rec && !rec.voided ? recordView(rec) : (rec && rec.voided ? recordView(rec) : null),
      recordVoided: rec ? rec.voided : false,
      skip: skip && !skip.voided ? { ...skip, atText: fmtTs(skip.at) } : (skip ? { ...skip, atText: fmtTs(skip.at) } : null),
      partBlocking,
    };
    return view;
  });

  const out = {
    cardNo: card.cardNo,
    title: card.title,
    aircraft: card.aircraft,
    trade: card.trade,
    type: card.type,
    plannedFinish: card.plannedFinish,
    plannedFinishText: fmtTs(card.plannedFinish),
    steps,
    retains,
    looseReady: ev.looseReady,
    strictReady: ev.strictReady,
    released: ev.released,
    releasedAtText: ev.released ? fmtTs(state.released.get(card.cardNo).at) : null,
    releaseBy: ev.released ? state.released.get(card.cardNo).staffName : null,
    blockers: ev.blockers,
  };

  if (includeTimeline) {
    out.timeline = buildCardTimeline(base, card, state, asOf);
  }
  return out;
}

function buildCardTimeline(base, card, state, asOf) {
  const items = [];
  for (const [, rec] of state.records) {
    if (rec.cardNo !== card.cardNo) continue;
    for (const sig of rec.signatures) {
      items.push({
        at: sig.at, atText: fmtTs(sig.at), kind: rec.voided ? 'sign-voided' : 'sign',
        stepNo: rec.stepNo, text: `${sig.staffName} 签署步骤 ${rec.stepNo}（${rec.dual ? '双人签' : '单人签'}）`,
        materials: rec.materials,
      });
    }
    if (rec.voided) {
      items.push({
        at: rec.voidAt, atText: fmtTs(rec.voidAt), kind: 'correction',
        stepNo: rec.stepNo,
        text: `${rec.voidBy} 冲正步骤 ${rec.stepNo} 原记录 ${rec.id}：${rec.voidReason}（原记录保留，已回链 ${rec.correctionId}）`,
      });
    }
  }
  for (const [key, sk] of state.skips) {
    if (!key.startsWith(card.cardNo + '#')) continue;
    const stepNo = Number(key.split('#')[1]);
    items.push({
      at: sk.at, atText: fmtTs(sk.at),
      kind: sk.voided ? 'unskip' : 'skip',
      stepNo,
      text: sk.voided
        ? `跳过被撤销：步骤 ${stepNo} 恢复执行`
        : `排故跳过步骤 ${stepNo}，原因：${sk.reason}；批准人：${sk.approverName}`,
    });
  }
  for (const r of state.retains.values()) {
    if (r.cardNo !== card.cardNo) continue;
    items.push({ at: r.openedAt, atText: fmtTs(r.openedAt), kind: 'retain-open', stepNo: r.stepNo, text: `建立保留项 ${r.id}：${r.title}` });
    if (r.closedAt) {
      items.push({ at: r.closedAt, atText: fmtTs(r.closedAt), kind: 'retain-close', stepNo: r.stepNo, text: `保留项 ${r.id} 关闭：${r.closedReason}（${r.closedBy}）` });
    }
  }
  const rel = state.released.get(card.cardNo);
  if (rel) items.push({ at: rel.at, atText: fmtTs(rel.at), kind: 'release', stepNo: null, text: `工卡按严格口径报完工放行（${rel.staffName}）` });
  return items.sort((a, b) => new Date(a.at) - new Date(b.at));
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new HttpError(413, 'body_too_large', '请求体过大'));
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new HttpError(400, 'bad_json', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;

  try {
    if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/index.html') ||
      pathname.startsWith('/app.js') || pathname.startsWith('/styles.css'))) {
      return serveStatic(req, res, pathname);
    }

    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    // GET 接口
    if (req.method === 'GET') {
      const ctx = loadContext();
      const { base, state, asOf } = ctx;

      if (pathname === '/api/overview') {
        const cards = base.cards.map((card) => {
          const detail = cardDetail(base, card, state, asOf, false);
          const done = detail.steps.filter((s) => s.status === 'signed' || s.status === 'skipped').length;
          return {
            cardNo: card.cardNo, title: card.title, aircraft: card.aircraft,
            trade: card.trade, type: card.type, plannedFinish: card.plannedFinish,
            plannedFinishText: detail.plannedFinishText,
            doneSteps: done, totalSteps: card.steps.length,
            strictReady: detail.strictReady, looseReady: detail.looseReady,
            released: detail.released,
            hasOverdueReview: detail.retains.some((r) => r.retainState === 'overdue'),
            hasDueTodayReview: detail.retains.some((r) => r.retainState === 'due-today'),
            openPartRetains: detail.retains.filter((r) => r.retainState === 'awaiting-part').length,
          };
        });
        const strictCount = cards.filter((c) => c.strictReady).length;
        const looseCount = cards.filter((c) => c.looseReady).length;
        return sendJson(res, 200, {
          asOf,
          policy: 'strict',
          counts: { total: cards.length, strictReady: strictCount, looseReady: looseCount },
          cards,
        });
      }

      if (pathname === '/api/cards') {
        const no = u.searchParams.get('cardNo');
        if (!no) throw new HttpError(400, 'cardno_required', '需要 cardNo 参数');
        const card = findCard(base, no);
        return sendJson(res, 200, cardDetail(base, card, state, asOf, true));
      }

      if (pathname === '/api/staff') {
        return sendJson(res, 200, { asOf, trades: base.trades, staff: base.staff });
      }

      if (pathname === '/api/retains') {
        const list = [...state.retains.values()].map((r) => {
          const card = base.cards.find((c) => c.cardNo === r.cardNo);
          return {
            ...r,
            aircraft: card ? card.aircraft : null,
            cardTitle: card ? card.title : null,
            retainState: retainState(r, asOf),
            stockQty: r.materialCode ? (state.stock.get(r.materialCode) ?? null) : null,
            closedAtText: r.closedAt ? fmtTs(r.closedAt) : null,
          };
        }).sort((a, b) => {
          const rank = { overdue: 0, 'due-today': 1, 'awaiting-part': 2, 'in-date': 3, closed: 4 };
          return rank[a.retainState] - rank[b.retainState];
        });
        return sendJson(res, 200, { asOf, inventory: stockSummary(base, state), retains: list });
      }

      if (pathname === '/api/events') {
        const no = u.searchParams.get('cardNo');
        const all = readEvents().map((ev) => ({ ...ev, atText: fmtTs(ev.at) }));
        const list = no ? all.filter((ev) => ev.cardNo === no) : all;
        return sendJson(res, 200, { total: all.length, events: list });
      }

      throw new HttpError(404, 'route_not_found', `未知接口 ${pathname}`);
    }

    // POST 接口
    if (req.method === 'POST') {
      const body = await readBody(req);
      const routes = {
        '/api/sign': () => { const c = loadContext(); return handleSign(c.base, c.events, c.state, body, c.asOf); },
        '/api/correct': () => { const c = loadContext(); return handleCorrect(c.base, c.events, c.state, body); },
        '/api/skip': () => { const c = loadContext(); return handleSkip(c.base, c.events, c.state, body, false); },
        '/api/unskip': () => { const c = loadContext(); return handleSkip(c.base, c.events, c.state, body, true); },
        '/api/retains/arrived': () => { const c = loadContext(); return handleRetain(c.base, c.events, c.state, body, 'arrived'); },
        '/api/retains/reviewed': () => { const c = loadContext(); return handleRetain(c.base, c.events, c.state, body, 'reviewed'); },
        '/api/release': () => { const c = loadContext(); return handleRelease(c.base, c.events, c.state, body, c.asOf); },
        '/api/reset': () => handleReset(),
      };
      const handler = routes[pathname];
      if (!handler) throw new HttpError(404, 'route_not_found', `未知接口 ${pathname}`);
      const result = await handler();
      return sendJson(res, 200, result);
    }

    throw new HttpError(405, 'method_not_allowed', '仅支持 GET/POST');
  } catch (err) {
    if (err instanceof HttpError) {
      return sendJson(res, err.status, { ok: false, error: err.code, message: err.message });
    }
    console.error(err);
    return sendJson(res, 500, { ok: false, error: 'internal', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`机务工卡执行与放行台子已启动: http://localhost:${PORT}`);
  console.log(`严格放行口径：步骤全闭合 + 缺件保留项全关闭 + 复查不超期 + 资质实时有效`);
});
