import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIDENCE_THRESHOLD,
  MODES,
  DomainError,
  createState,
  importSamples,
  confirmCorrection,
  aggregate,
  buildEvidenceSnapshot,
} from '../lib/domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'data', 'sample-import.json'), 'utf8')
);
const NOW = '2026-11-21T08:00:00.000Z';

function importAt(now = NOW) {
  return importSamples(createState(), sample, now);
}

// 归集不变量：确认改号绝不新增箱，同一张原图在任何模式下都只能归属一个批号。
// - confirm-first：待确认箱不入账，actual + pending = 原图总数
// - provisional：待确认箱已按候选批号暂记，actual = 原图总数
function assertMoveInvariant(state, report) {
  const sumActual = report.batches.reduce((s, b) => s + b.actualBoxes, 0);
  const expected =
    report.mode === MODES.PROVISIONAL
      ? state.labels.length
      : state.labels.length - report.totals.pendingTotal;
  assert.equal(sumActual, expected);
  const allImageIds = report.batches.flatMap((b) => b.imageIds);
  assert.equal(new Set(allImageIds).size, allImageIds.length, '同一原图不能被归集到两个批号');
  assert.equal(allImageIds.length, sumActual);
  // 暂记箱与正式入账箱必须互斥且覆盖全部待确认箱
  const provisionalIds = report.batches.flatMap((b) => b.provisionalImageIds);
  const confirmedIds = allImageIds.filter((id) => !provisionalIds.includes(id));
  assert.equal(
    new Set([...provisionalIds, ...confirmedIds]).size,
    allImageIds.length
  );
}

function batchMap(report) {
  return new Map(report.batches.map((b) => [b.batchNo, b]));
}

describe('导入标签识别样本（正常路径）', () => {
  test('高置信度自动确认，低置信度保留原图编号与候选批号待确认', () => {
    const state = importAt();
    assert.equal(state.labels.length, 6);

    const auto = state.labels.filter((l) => l.status === 'auto-confirmed');
    const pending = state.labels.filter((l) => l.status === 'pending-confirmation');
    assert.equal(auto.length, 3);
    assert.equal(pending.length, 3);

    for (const label of state.labels) {
      const expectLow = label.confidence < CONFIDENCE_THRESHOLD;
      assert.equal(label.status, expectLow ? 'pending-confirmation' : 'auto-confirmed');
      assert.ok(label.imageId, '每箱必须保留原图编号');
      assert.ok(label.candidateBatchNo, '低置信度也必须保留候选批号');
    }
    assert.deepEqual(
      pending.map((l) => l.imageId).sort(),
      ['IMG-004', 'IMG-005', 'IMG-006']
    );
    assert.ok(state.events.some((e) => e.type === 'low-confidence-flag'));
  });

  test('同一原图编号重复导入应被拒绝', () => {
    const payload = {
      shiftTable: sample.shiftTable,
      labels: [sample.labels[0], { ...sample.labels[0] }],
    };
    assert.throws(
      () => importSamples(createState(), payload),
      (err) => err instanceof DomainError && err.message.includes('IMG-001')
    );
  });
});

describe('先等确认再入账模式（confirm-first）', () => {
  test('确认前低置信度箱不计入任何批号，状态明确提示等待确认', () => {
    const state = importAt();
    const report = aggregate(state, MODES.CONFIRM_FIRST);
    assert.equal(report.ledgerStatus, 'awaiting-confirmation');
    assert.match(report.ledgerStatusLabel, /等待确认/);
    assert.equal(report.totals.pendingTotal, 3);
    assert.equal(report.totals.actualTotal, 3);

    const rows = batchMap(report);
    assert.equal(rows.get('A01').actualBoxes, 2); // 只有两箱高置信度
    assert.equal(rows.get('A02').actualBoxes, 1);
    assert.equal(rows.get('B01').actualBoxes, 0);
    assert.equal(rows.get('B01').status, 'short');
    assert.deepEqual(
      report.pendingBoxes.map((p) => p.imageId).sort(),
      ['IMG-004', 'IMG-005', 'IMG-006']
    );
    assertMoveInvariant(state, report);
  });

  test('人工改号只移动已认领箱，全部确认后与交班次表账实相符', () => {
    let state = importAt();
    state = confirmCorrection(state, 'IMG-004', 'A02', MODES.CONFIRM_FIRST);
    state = confirmCorrection(state, 'IMG-005', 'A02', MODES.CONFIRM_FIRST); // 误识 B01 改回 A02
    state = confirmCorrection(state, 'IMG-006', 'B01', MODES.CONFIRM_FIRST);

    assert.equal(state.labels.length, 6, '确认改号不能新增箱，箱数不变');
    const report = aggregate(state, MODES.CONFIRM_FIRST);
    assert.equal(report.ledgerStatus, 'final-confirmed');
    assert.equal(report.totals.pendingTotal, 0);

    const rows = batchMap(report);
    assert.deepEqual(
      [rows.get('A01').actualBoxes, rows.get('A02').actualBoxes, rows.get('B01').actualBoxes],
      [2, 3, 1]
    );
    for (const batchNo of ['A01', 'A02', 'B01']) {
      assert.equal(rows.get(batchNo).status, 'matched');
      assert.equal(rows.get(batchNo).difference, 0);
    }
    // IMG-005 被移动到 A02，不能留在 B01
    assert.deepEqual(rows.get('A02').imageIds.sort(), ['IMG-003', 'IMG-004', 'IMG-005']);
    assert.deepEqual(rows.get('B01').imageIds, ['IMG-006']);
    assertMoveInvariant(state, report);
    assert.equal(report.reversalEntries.length, 0, '确认后入账模式不产生冲正分录');
  });

  test('同一张原图重复确认应被拒绝', () => {
    let state = importAt();
    state = confirmCorrection(state, 'IMG-004', 'A02', MODES.CONFIRM_FIRST);
    assert.throws(
      () => confirmCorrection(state, 'IMG-004', 'A02', MODES.CONFIRM_FIRST),
      (err) => err instanceof DomainError && err.statusCode === 409
    );
  });
});

describe('先记暂定量再冲正模式（provisional）', () => {
  test('导入后低置信度箱按候选批号暂记，状态提示暂定量待确认', () => {
    const state = importAt();
    const report = aggregate(state, MODES.PROVISIONAL);
    assert.equal(report.ledgerStatus, 'provisional-open');
    assert.match(report.ledgerStatusLabel, /暂定量/);

    const rows = batchMap(report);
    assert.equal(rows.get('A01').actualBoxes, 2);
    assert.equal(rows.get('A02').actualBoxes, 2); // IMG-003 + 暂记 IMG-004
    assert.equal(rows.get('B01').actualBoxes, 2); // 暂记 IMG-005、IMG-006
    assert.equal(rows.get('A02').status, 'short');
    assert.equal(rows.get('B01').status, 'over');
    assert.equal(report.totals.actualTotal, 6, '暂定量模式下全部 6 箱先挂账');
    assertMoveInvariant(state, report);
  });

  test('改号确认产生红冲蓝补分录，箱从原批号移动到新批号而非新增', () => {
    let state = importAt();
    state = confirmCorrection(state, 'IMG-005', 'A02', MODES.PROVISIONAL, NOW);

    const label = state.labels.find((l) => l.imageId === 'IMG-005');
    assert.equal(label.status, 'manually-confirmed');
    assert.equal(label.confirmedBatchNo, 'A02');
    assert.equal(label.correctionHistory[0].changed, true);

    const report = aggregate(state, MODES.PROVISIONAL);
    assert.equal(report.reversalEntries.length, 1);
    assert.deepEqual(report.reversalEntries[0], {
      at: NOW,
      imageId: 'IMG-005',
      fromBatchNo: 'B01',
      toBatchNo: 'A02',
      boxes: 1,
    });
    const rows = batchMap(report);
    assert.equal(rows.get('B01').actualBoxes, 1, '红冲后 B01 由 2 降为 1');
    assert.equal(rows.get('A02').actualBoxes, 3, '蓝补后 A02 由 2 升为 3');
    assert.equal(state.labels.length, 6, '冲正移动不新增箱');
    assertMoveInvariant(state, report);
  });

  test('确认但未改号不产生冲正；全部确认后状态为冲正完成且账实相符', () => {
    let state = importAt();
    state = confirmCorrection(state, 'IMG-004', 'A02', MODES.PROVISIONAL, NOW);
    state = confirmCorrection(state, 'IMG-005', 'A02', MODES.PROVISIONAL, NOW);
    state = confirmCorrection(state, 'IMG-006', 'B01', MODES.PROVISIONAL, NOW);

    const report = aggregate(state, MODES.PROVISIONAL);
    assert.equal(report.ledgerStatus, 'final-reversed');
    assert.equal(report.reversalEntries.length, 1, '仅 IMG-005 改号产生一条冲正');
    const rows = batchMap(report);
    for (const batchNo of ['A01', 'A02', 'B01']) {
      assert.equal(rows.get(batchNo).status, 'matched');
    }
    assertMoveInvariant(state, report);
  });

  test('两种模式最终归集结果一致，差异只在中间状态与冲正分录', () => {
    let provisional = importAt();
    let confirmFirst = importAt();
    for (const [imageId, batchNo] of [
      ['IMG-004', 'A02'],
      ['IMG-005', 'A02'],
      ['IMG-006', 'B01'],
    ]) {
      provisional = confirmCorrection(provisional, imageId, batchNo, MODES.PROVISIONAL);
      confirmFirst = confirmCorrection(confirmFirst, imageId, batchNo, MODES.CONFIRM_FIRST);
    }
    const rp = aggregate(provisional, MODES.PROVISIONAL);
    const rc = aggregate(confirmFirst, MODES.CONFIRM_FIRST);
    assert.deepEqual(
      rp.batches.map((b) => [b.batchNo, b.actualBoxes, b.status]),
      rc.batches.map((b) => [b.batchNo, b.actualBoxes, b.status])
    );
    assert.equal(rp.totals.actualTotal, rc.totals.actualTotal);
  });
});

describe('异常输入与边界情况', () => {
  test('交班次表为空或缺失应报错', () => {
    assert.throws(
      () => importSamples(createState(), { shiftTable: [], labels: sample.labels }),
      (err) => err instanceof DomainError && err.statusCode === 400
    );
    assert.throws(
      () => importSamples(createState(), { labels: sample.labels }),
      (err) => err instanceof DomainError
    );
  });

  test('计划箱数不是正整数应报错', () => {
    const payload = {
      shiftTable: [{ batchNo: 'A01', plannedBoxes: 0 }],
      labels: sample.labels,
    };
    assert.throws(() => importSamples(createState(), payload), DomainError);
  });

  test('置信度超出 0~1 应报错', () => {
    const payload = {
      shiftTable: sample.shiftTable,
      labels: [{ imageId: 'X1', candidateBatchNo: 'A01', confidence: 1.2 }],
    };
    assert.throws(() => importSamples(createState(), payload), /置信度/);
  });

  test('缺少候选批号或原图编号应报错', () => {
    assert.throws(
      () =>
        importSamples(createState(), {
          shiftTable: sample.shiftTable,
          labels: [{ imageId: 'X1', confidence: 0.5 }],
        }),
      /候选批号/
    );
    assert.throws(
      () =>
        importSamples(createState(), {
          shiftTable: sample.shiftTable,
          labels: [{ candidateBatchNo: 'A01', confidence: 0.5 }],
        }),
      /原图编号/
    );
  });

  test('交班次表批号重复应报错', () => {
    const payload = {
      shiftTable: [
        { batchNo: 'A01', plannedBoxes: 1 },
        { batchNo: 'A01', plannedBoxes: 2 },
      ],
      labels: sample.labels,
    };
    assert.throws(() => importSamples(createState(), payload), /重复/);
  });

  test('确认不存在的原图返回 404，确认批号为空返回 400', () => {
    const state = importAt();
    assert.throws(
      () => confirmCorrection(state, 'IMG-999', 'A02', MODES.CONFIRM_FIRST),
      (err) => err instanceof DomainError && err.statusCode === 404
    );
    assert.throws(
      () => confirmCorrection(state, 'IMG-004', '  ', MODES.CONFIRM_FIRST),
      (err) => err instanceof DomainError && err.statusCode === 400
    );
  });

  test('未导入样本时归集应报 409', () => {
    assert.throws(
      () => aggregate(createState(), MODES.CONFIRM_FIRST),
      (err) => err instanceof DomainError && err.statusCode === 409
    );
  });

  test('未知处理模式应报错', () => {
    const state = importAt();
    assert.throws(() => aggregate(state, 'bogus'), DomainError);
  });

  test('识别批号不在交班次表中时标记 unknown-batch', () => {
    const payload = {
      shiftTable: [{ batchNo: 'A01', plannedBoxes: 1 }],
      labels: [{ imageId: 'IMG-X', candidateBatchNo: 'Z99', confidence: 0.99 }],
    };
    const state = importSamples(createState(), payload);
    const report = aggregate(state, MODES.CONFIRM_FIRST);
    const z99 = batchMap(report).get('Z99');
    assert.equal(z99.status, 'unknown-batch');
    assert.equal(z99.plannedBoxes, 0);
    assert.equal(z99.actualBoxes, 1);
  });

  test('evidence 快照不含时间戳且可稳定核对', () => {
    let state = importSamples(createState(), sample, '2026-11-21T08:00:00.000Z');
    state = confirmCorrection(state, 'IMG-005', 'A02', MODES.PROVISIONAL, '2026-11-21T09:00:00.000Z');
    const report = aggregate(state, MODES.PROVISIONAL);
    const evidence = buildEvidenceSnapshot(state, report);
    const text = JSON.stringify(evidence);
    assert.ok(!text.includes('2026-11-21T'), '快照不应包含时间戳');
    assert.equal(evidence.ledgerStatus, 'provisional-open');
    const img5 = evidence.labels.find((l) => l.imageId === 'IMG-005');
    assert.equal(img5.confirmedBatchNo, 'A02');
    assert.equal(evidence.totals.labelCount, 6);

    // 同样的业务状态产生完全相同的快照（可用于操作前后比对）
    const again = buildEvidenceSnapshot(state, aggregate(state, MODES.PROVISIONAL));
    assert.deepEqual(evidence, again);
  });
});
