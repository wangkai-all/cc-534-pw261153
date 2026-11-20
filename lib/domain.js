// 核心业务逻辑：包装线交班次表 + 标签识别结果归集
// 纯函数实现，不依赖 Node 内置模块以外的任何依赖，也不做任何 I/O。

export const CONFIDENCE_THRESHOLD = 0.8;

// 低置信度处理模式：
// - confirm-first：先等人工确认，确认后才入账（未确认的箱不计入任何批号）
// - provisional  ：先按候选批号记暂定量，人工改号确认后做冲正（红冲 + 蓝补）
export const MODES = Object.freeze({
  CONFIRM_FIRST: 'confirm-first',
  PROVISIONAL: 'provisional',
});

export class DomainError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'DomainError';
    this.statusCode = statusCode;
  }
}

const clone = (value) =>
  typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));

export function createState() {
  return {
    shiftTable: [], // 交班次表行 { batchNo, shift, plannedBoxes }
    labels: [], // 识别结果（每箱一条，以原图编号 imageId 唯一标识）
    events: [], // 领域事件 / 审计日志
    importedAt: null,
  };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// 校验并规范化一次「导入标签识别样本」的载荷。
// 识别结果全部由手工给定（payload 里的 source 标注 manual），本函数不接任何识别服务。
export function validatePayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DomainError('导入载荷必须是对象', 400);
  }

  if (!Array.isArray(payload.shiftTable) || payload.shiftTable.length === 0) {
    throw new DomainError('交班次表 shiftTable 必须是非空数组', 400);
  }
  if (!Array.isArray(payload.labels) || payload.labels.length === 0) {
    throw new DomainError('标签识别结果 labels 必须是非空数组', 400);
  }

  const shiftTable = payload.shiftTable.map((row, i) => {
    if (row === null || typeof row !== 'object') {
      throw new DomainError(`交班次表第 ${i + 1} 行不是对象`, 400);
    }
    if (!isNonEmptyString(row.batchNo)) {
      throw new DomainError(`交班次表第 ${i + 1} 行缺少批号 batchNo`, 400);
    }
    const plannedBoxes = Number(row.plannedBoxes);
    if (!Number.isInteger(plannedBoxes) || plannedBoxes <= 0) {
      throw new DomainError(
        `交班次表批号 ${row.batchNo} 的计划箱数 plannedBoxes 必须是正整数`,
        400
      );
    }
    return {
      batchNo: row.batchNo.trim(),
      shift: isNonEmptyString(row.shift) ? row.shift.trim() : '未指定班次',
      plannedBoxes,
    };
  });

  const seenBatch = new Set();
  for (const row of shiftTable) {
    if (seenBatch.has(row.batchNo)) {
      throw new DomainError(`交班次表中批号 ${row.batchNo} 重复`, 400);
    }
    seenBatch.add(row.batchNo);
  }

  const labels = payload.labels.map((row, i) => {
    if (row === null || typeof row !== 'object') {
      throw new DomainError(`标签识别结果第 ${i + 1} 条不是对象`, 400);
    }
    if (!isNonEmptyString(row.imageId)) {
      throw new DomainError(`标签识别结果第 ${i + 1} 条缺少原图编号 imageId`, 400);
    }
    if (!isNonEmptyString(row.candidateBatchNo)) {
      throw new DomainError(
        `原图 ${row.imageId} 缺少候选批号 candidateBatchNo`,
        400
      );
    }
    const confidence = Number(row.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new DomainError(
        `原图 ${row.imageId} 的置信度 confidence 必须是 0~1 之间的数字`,
        400
      );
    }
    return {
      imageId: row.imageId.trim(),
      candidateBatchNo: row.candidateBatchNo.trim(),
      confidence,
      note: isNonEmptyString(row.note) ? row.note.trim() : '',
    };
  });

  const seenImage = new Set();
  for (const label of labels) {
    if (seenImage.has(label.imageId)) {
      throw new DomainError(`原图编号 ${label.imageId} 在识别结果中重复`, 400);
    }
    seenImage.add(label.imageId);
  }

  return {
    source: isNonEmptyString(payload.source) ? payload.source.trim() : 'manual',
    shiftTable,
    labels,
  };
}

// 导入样本：重置为本次交班次表 + 识别结果，并按置信度给每箱打初始状态。
export function importSamples(state, payload, now = new Date().toISOString()) {
  const clean = validatePayload(payload);
  const next = createState();
  next.importedAt = now;

  next.shiftTable = clean.shiftTable;
  next.labels = clean.labels.map((label) => {
    const low = label.confidence < CONFIDENCE_THRESHOLD;
    return {
      ...label,
      // 高置信度：自动确认，入账批号即候选批号
      // 低置信度：保留原图编号与候选批号，等待人工确认
      status: low ? 'pending-confirmation' : 'auto-confirmed',
      confirmedBatchNo: low ? null : label.candidateBatchNo,
      confirmedAt: low ? null : now,
      correctionHistory: [],
    };
  });

  next.events.push({
    at: now,
    type: 'import',
    message: `导入 ${clean.shiftTable.length} 个批号的交班次表与 ${clean.labels.length} 箱标签识别结果（来源：${clean.source}，手工给定识别结果）`,
  });
  const pendingCount = next.labels.filter(
    (l) => l.status === 'pending-confirmation'
  ).length;
  if (pendingCount > 0) {
    next.events.push({
      at: now,
      type: 'low-confidence-flag',
      message: `${pendingCount} 箱识别置信度低于 ${CONFIDENCE_THRESHOLD}，已保留原图编号和候选批号，等待人工确认改号`,
    });
  }
  return next;
}

// 「确认一条改号」：人工确认/修正某张原图对应的批号。
// 关键约束：只移动这张原图已认领的那一箱，绝不新增箱数。
export function confirmCorrection(
  state,
  imageId,
  correctedBatchNo,
  mode = MODES.CONFIRM_FIRST,
  now = new Date().toISOString()
) {
  if (!isNonEmptyString(imageId)) {
    throw new DomainError('缺少原图编号 imageId', 400);
  }
  if (!isNonEmptyString(correctedBatchNo)) {
    throw new DomainError('缺少确认后的批号 correctedBatchNo', 400);
  }
  if (!Object.values(MODES).includes(mode)) {
    throw new DomainError(`未知处理模式 ${mode}`, 400);
  }

  const next = clone(state);
  const label = next.labels.find((l) => l.imageId === imageId.trim());
  if (!label) {
    throw new DomainError(`找不到原图编号 ${imageId}，无法确认改号`, 404);
  }
  if (label.status !== 'pending-confirmation') {
    throw new DomainError(
      `原图 ${imageId} 当前状态为 ${label.status}，已确认的箱不能重复确认`,
      409
    );
  }

  const previousBatchNo = label.candidateBatchNo;
  const finalBatchNo = correctedBatchNo.trim();
  const changed = previousBatchNo !== finalBatchNo;

  label.status = 'manually-confirmed';
  label.confirmedBatchNo = finalBatchNo;
  label.confirmedAt = now;
  label.correctionHistory.push({
    at: now,
    fromBatchNo: previousBatchNo,
    toBatchNo: finalBatchNo,
    changed,
    mode,
  });

  next.events.push({
    at: now,
    type: 'confirm-correction',
    message: changed
      ? `人工确认改号：原图 ${imageId} 的批号由候选 ${previousBatchNo} 改为 ${finalBatchNo}（移动 1 箱，不新增箱）`
      : `人工确认：原图 ${imageId} 维持候选批号 ${finalBatchNo}（认领 1 箱，不新增箱）`,
    imageId,
    fromBatchNo: previousBatchNo,
    toBatchNo: finalBatchNo,
    changed,
  });

  // 暂定量模式下，改号意味着先红冲原批号的暂定量，再蓝补到新批号。
  // confirm-first 模式下低置信度箱此前从未入账，直接认领即可，无冲正。
  if (mode === MODES.PROVISIONAL && changed) {
    next.events.push({
      at: now,
      type: 'reversal',
      message: `冲正：红冲 ${previousBatchNo} 暂定量 1 箱（原图 ${imageId}），蓝补 ${finalBatchNo} 1 箱`,
      imageId,
      reversalFrom: previousBatchNo,
      reversalTo: finalBatchNo,
      boxes: 1,
    });
  }

  return next;
}

// 「对照批号归集」：以已确认的箱为准，对照交班次表逐批号归集。
export function aggregate(state, mode = MODES.CONFIRM_FIRST) {
  if (!Object.values(MODES).includes(mode)) {
    throw new DomainError(`未知处理模式 ${mode}`, 400);
  }
  if (state.labels.length === 0) {
    throw new DomainError('尚未导入标签识别样本，无法归集', 409);
  }

  const pending = state.labels.filter((l) => l.confirmedBatchNo === null);

  // 参与归集计箱的记录：
  // - confirm-first：只有已确认箱入账，待确认箱不归属任何批号
  // - provisional：待确认箱按候选批号先记暂定量（provisional: true），确认改号后冲正移动
  const postings = state.labels
    .filter((l) => l.confirmedBatchNo !== null)
    .map((l) => ({
      imageId: l.imageId,
      batchNo: l.confirmedBatchNo,
      provisional: false,
    }));
  if (mode === MODES.PROVISIONAL) {
    for (const label of pending) {
      postings.push({
        imageId: label.imageId,
        batchNo: label.candidateBatchNo,
        provisional: true,
      });
    }
  }

  // 每个批号的实际箱数（同一原图只出现一次，天然不会重复计箱）
  const countByBatch = new Map();
  const provisionalByBatch = new Map();
  for (const posting of postings) {
    countByBatch.set(
      posting.batchNo,
      (countByBatch.get(posting.batchNo) ?? 0) + 1
    );
    if (posting.provisional) {
      provisionalByBatch.set(
        posting.batchNo,
        (provisionalByBatch.get(posting.batchNo) ?? 0) + 1
      );
    }
  }

  const knownBatchNos = new Set(state.shiftTable.map((r) => r.batchNo));
  const allBatchNos = new Set([
    ...knownBatchNos,
    ...countByBatch.keys(),
  ]);

  const batches = [...allBatchNos]
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map((batchNo) => {
      const shiftRow = state.shiftTable.find((r) => r.batchNo === batchNo);
      const actualBoxes = countByBatch.get(batchNo) ?? 0;
      const plannedBoxes = shiftRow ? shiftRow.plannedBoxes : 0;
      const imageIds = postings
        .filter((p) => p.batchNo === batchNo)
        .map((p) => p.imageId)
        .sort();
      const provisionalBoxes = provisionalByBatch.get(batchNo) ?? 0;
      const provisionalImageIds = postings
        .filter((p) => p.batchNo === batchNo && p.provisional)
        .map((p) => p.imageId)
        .sort();
      let status;
      if (!shiftRow) {
        status = 'unknown-batch'; // 识别批号在交班次表中不存在
      } else if (actualBoxes === plannedBoxes) {
        status = 'matched';
      } else if (actualBoxes < plannedBoxes) {
        status = 'short';
      } else {
        status = 'over';
      }
      return {
        batchNo,
        shift: shiftRow ? shiftRow.shift : '交班次表无此批号',
        plannedBoxes,
        actualBoxes,
        provisionalBoxes,
        difference: actualBoxes - plannedBoxes,
        status,
        imageIds,
        provisionalImageIds,
      };
    });

  const plannedTotal = state.shiftTable.reduce((sum, r) => sum + r.plannedBoxes, 0);
  const actualTotal = postings.length;
  const reversalEvents = state.events.filter((e) => e.type === 'reversal');

  // 状态文案：让读数的人明确当前是哪种模式、数据处于什么状态
  let ledgerStatus;
  if (pending.length > 0) {
    ledgerStatus =
      mode === MODES.PROVISIONAL
        ? 'provisional-open' // 仍有暂定量待人工确认，数字可能被冲正
        : 'awaiting-confirmation'; // 先等确认再入账，未确认箱暂不计入任何批号
  } else {
    ledgerStatus = mode === MODES.PROVISIONAL ? 'final-reversed' : 'final-confirmed';
  }

  return {
    mode,
    modeLabel:
      mode === MODES.PROVISIONAL
        ? '先记暂定量，确认改号后红冲蓝补'
        : '先等人工确认，确认后才入账',
    ledgerStatus,
    ledgerStatusLabel: {
      'awaiting-confirmation': '等待确认中：低置信度箱尚未入账，归集数不含这些箱',
      'provisional-open':
        '暂定量待确认：低置信度箱已按候选批号暂记，改号确认后会冲正移动',
      'final-confirmed': '已全部确认入账（确认后入账模式）',
      'final-reversed': '已全部确认，暂定量冲正完成（红冲蓝补模式）',
    }[ledgerStatus],
    batches,
    pendingBoxes: pending.map((l) => ({
      imageId: l.imageId,
      candidateBatchNo: l.candidateBatchNo,
      confidence: l.confidence,
      note: l.note,
    })),
    reversalEntries: reversalEvents.map((e) => ({
      at: e.at,
      imageId: e.imageId,
      fromBatchNo: e.reversalFrom,
      toBatchNo: e.reversalTo,
      boxes: e.boxes,
    })),
    totals: {
      plannedTotal,
      actualTotal,
      pendingTotal: pending.length,
      difference: actualTotal - plannedTotal,
      labelCount: state.labels.length,
    },
  };
}

// 供页面 data-evidence-result 使用的稳定快照：去掉易变时间戳，只保留可核对的业务结果。
export function buildEvidenceSnapshot(state, report) {
  return {
    mode: report.mode,
    ledgerStatus: report.ledgerStatus,
    labelCount: state.labels.length,
    labels: state.labels
      .map((l) => ({
        imageId: l.imageId,
        candidateBatchNo: l.candidateBatchNo,
        confidence: l.confidence,
        status: l.status,
        confirmedBatchNo: l.confirmedBatchNo,
      }))
      .sort((a, b) => a.imageId.localeCompare(b.imageId)),
    batches: report.batches.map((b) => ({
      batchNo: b.batchNo,
      plannedBoxes: b.plannedBoxes,
      actualBoxes: b.actualBoxes,
      provisionalBoxes: b.provisionalBoxes,
      difference: b.difference,
      status: b.status,
      imageIds: b.imageIds,
      provisionalImageIds: b.provisionalImageIds,
    })),
    pendingBoxes: report.pendingBoxes.map((p) => p.imageId).sort(),
    reversalEntries: report.reversalEntries.map((r) => ({
      imageId: r.imageId,
      fromBatchNo: r.fromBatchNo,
      toBatchNo: r.toBatchNo,
      boxes: r.boxes,
    })),
    totals: report.totals,
  };
}
