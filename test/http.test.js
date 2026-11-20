import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'data', 'sample-import.json'), 'utf8')
);

let baseUrl;
let server;

function request(method, pathname, body) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function api(method, pathname, body) {
  const res = await request(method, pathname, body);
  const data = await res.json();
  return { status: res.status, data };
}

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('HTTP 端到端（node server.js 同款服务）', () => {
  test('静态页面可访问，业务结果区带 data-evidence-result 属性', async () => {
    const res = await request('GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /id="result"[^>]*data-evidence-result/);
    assert.match(html, /导入标签识别样本/);
    assert.match(html, /确认一条改号/);
    assert.match(html, /对照批号归集/);
  });

  test('完整业务流：导入 → 暂定量改号冲正 → 对照归集，箱数始终不增加', async () => {
    await api('POST', '/api/reset');

    // 1. 导入手工给定的标签识别样本
    const imported = await api('POST', '/api/import', {
      ...sample,
      mode: 'provisional',
    });
    assert.equal(imported.status, 200);
    let report = imported.data.report;
    assert.equal(report.ledgerStatus, 'provisional-open');
    assert.equal(report.evidence.labelCount, 6);
    assert.equal(report.totals.actualTotal, 6);
    const b01Before = report.evidence.batches.find((b) => b.batchNo === 'B01');
    assert.equal(b01Before.actualBoxes, 2);

    // 2. 确认一条改号：IMG-005 由误识的 B01 改回 A02
    const confirmed = await api('POST', '/api/confirm', {
      imageId: 'IMG-005',
      correctedBatchNo: 'A02',
      mode: 'provisional',
    });
    assert.equal(confirmed.status, 200);
    report = confirmed.data.report;
    assert.equal(report.reversalEntries.length, 1);
    assert.deepEqual(
      { ...report.reversalEntries[0], at: null },
      {
        at: null,
        imageId: 'IMG-005',
        fromBatchNo: 'B01',
        toBatchNo: 'A02',
        boxes: 1,
      }
    );
    assert.ok(new Date(report.reversalEntries[0].at).toISOString(), '冲正分录带时间戳');
    const b01 = report.evidence.batches.find((b) => b.batchNo === 'B01');
    const a02 = report.evidence.batches.find((b) => b.batchNo === 'A02');
    assert.equal(b01.actualBoxes, 1, '红冲移动后 B01 减少一箱');
    assert.equal(a02.actualBoxes, 3, '蓝补移动后 A02 增加一箱');
    assert.equal(report.evidence.labelCount, 6, '没有重新添一箱');
    assert.equal(
      report.evidence.labels.find((l) => l.imageId === 'IMG-005').confirmedBatchNo,
      'A02'
    );

    // 3. 对照批号归集
    const agg = await api('POST', '/api/aggregate', { mode: 'provisional' });
    assert.equal(agg.status, 200);
    report = agg.data.report;
    assert.equal(report.ledgerStatus, 'provisional-open', '仍有 2 箱待确认');
    assert.equal(report.totals.pendingTotal, 2);

    // 4. 切回「先等确认再入账」模式，读数的人应看到不同状态语义
    const switched = await api('POST', '/api/aggregate', { mode: 'confirm-first' });
    assert.equal(switched.data.report.ledgerStatus, 'awaiting-confirmation');
    assert.equal(switched.data.report.totals.actualTotal, 4, '未确认箱不入账');

    // 5. 确认剩余两箱后账实相符
    await api('POST', '/api/confirm', {
      imageId: 'IMG-004',
      correctedBatchNo: 'A02',
      mode: 'confirm-first',
    });
    const final = await api('POST', '/api/confirm', {
      imageId: 'IMG-006',
      correctedBatchNo: 'B01',
      mode: 'confirm-first',
    });
    assert.equal(final.data.report.ledgerStatus, 'final-confirmed');
    for (const b of final.data.report.evidence.batches) {
      assert.equal(b.status, 'matched');
      assert.equal(b.difference, 0);
    }
    const totalBoxes = final.data.report.evidence.batches.reduce(
      (sum, b) => sum + b.actualBoxes,
      0
    );
    assert.equal(totalBoxes, 6);
  });

  test('异常：未导入先归集返回 409', async () => {
    await api('POST', '/api/reset');
    const { status, data } = await api('POST', '/api/aggregate', {
      mode: 'confirm-first',
    });
    assert.equal(status, 409);
    assert.match(data.error, /尚未导入/);
  });

  test('异常：重复确认同一张原图返回 409，确认不存在原图返回 404', async () => {
    await api('POST', '/api/reset');
    await api('POST', '/api/import', { ...sample, mode: 'confirm-first' });

    const first = await api('POST', '/api/confirm', {
      imageId: 'IMG-004',
      correctedBatchNo: 'A02',
      mode: 'confirm-first',
    });
    assert.equal(first.status, 200);

    const dup = await api('POST', '/api/confirm', {
      imageId: 'IMG-004',
      correctedBatchNo: 'A02',
      mode: 'confirm-first',
    });
    assert.equal(dup.status, 409);

    const missing = await api('POST', '/api/confirm', {
      imageId: 'IMG-NOPE',
      correctedBatchNo: 'A02',
      mode: 'confirm-first',
    });
    assert.equal(missing.status, 404);
  });

  test('异常：非法 JSON 返回 400，路径穿越访问被拒绝', async () => {
    const res = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /JSON/);

    // 百分号编码的 ../ 绕过客户端规范化，验证服务端目录穿越防护不泄露源码
    const blocked = await request('GET', '/%2e%2e/server.js');
    assert.notEqual(blocked.status, 200);
    const body = await blocked.text();
    assert.ok(!body.includes('createServer'), '静态服务不能泄露 server.js 源码');

    const blockedDouble = await request('GET', '/%2e%2e/%2e%2e/package.json');
    assert.notEqual(blockedDouble.status, 200);
  });

  test('GET /api/state 与 /api/sample 可用于页面初始化和样本下载', async () => {
    const sampleRes = await api('GET', '/api/sample');
    assert.equal(sampleRes.status, 200);
    assert.equal(sampleRes.data.source, 'manual-sample');
    assert.equal(sampleRes.data.labels.length, 6);

    const stateRes = await api('GET', '/api/state?mode=confirm-first');
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.data.imported, true);
    assert.ok(stateRes.data.report.evidence);
  });
});
