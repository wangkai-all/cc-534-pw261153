// 本地 HTTP 服务：仅使用 Node.js 内置模块。
// 启动：node server.js （读取环境变量 PORT，默认 3000，绑定 127.0.0.1）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODES,
  DomainError,
  createState,
  importSamples,
  confirmCorrection,
  aggregate,
  buildEvidenceSnapshot,
} from './lib/domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SAMPLE_PATH = path.join(__dirname, 'data', 'sample-import.json');
const MAX_BODY_BYTES = 1024 * 1024;

// 进程内状态：本地演示用，导入样本即重置。
let state = createState();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new DomainError('请求体超过 1MB 限制', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new DomainError('请求体不是合法 JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

function buildReport(mode) {
  const report = aggregate(state, mode);
  return {
    ...report,
    evidence: buildEvidenceSnapshot(state, report),
    events: state.events,
  };
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/state') {
    const mode = normalizeMode(url.searchParams.get('mode'));
    return sendJson(res, 200, {
      imported: state.labels.length > 0,
      importedAt: state.importedAt,
      report: state.labels.length > 0 ? buildReport(mode) : null,
    });
  }

  if (route === 'GET /api/sample') {
    const raw = await fs.promises.readFile(SAMPLE_PATH, 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(raw);
  }

  if (route === 'POST /api/import') {
    const body = await readJsonBody(req);
    state = importSamples(state, body);
    const mode = normalizeMode(body.mode);
    return sendJson(res, 200, {
      message: `已导入 ${state.shiftTable.length} 个批号、${state.labels.length} 箱识别结果`,
      report: buildReport(mode),
    });
  }

  if (route === 'POST /api/confirm') {
    const body = await readJsonBody(req);
    const mode = normalizeMode(body.mode);
    state = confirmCorrection(state, body.imageId, body.correctedBatchNo, mode);
    return sendJson(res, 200, {
      message: `原图 ${body.imageId} 已确认，批号归集为 ${body.correctedBatchNo}（移动已认领箱，未新增箱）`,
      report: buildReport(mode),
    });
  }

  if (route === 'POST /api/aggregate') {
    const body = await readJsonBody(req).catch(() => ({}));
    const mode = normalizeMode(body.mode);
    return sendJson(res, 200, { report: buildReport(mode) });
  }

  if (route === 'POST /api/reset') {
    state = createState();
    return sendJson(res, 200, { message: '已重置本地状态' });
  }

  throw new DomainError(`接口不存在：${route}`, 404);
}

function normalizeMode(value) {
  return value === MODES.PROVISIONAL ? MODES.PROVISIONAL : MODES.CONFIRM_FIRST;
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: '禁止访问' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      return sendJson(res, 404, { error: '资源不存在' });
    }
    const type = MIME[path.extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(data);
  });
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    Promise.resolve()
      .then(() =>
        url.pathname.startsWith('/api/')
          ? handleApi(req, res, url)
          : serveStatic(req, res, url)
      )
      .catch((err) => {
        if (err instanceof DomainError) {
          return sendJson(res, err.statusCode, { error: err.message });
        }
        // eslint-disable-next-line no-console
        console.error(err);
        return sendJson(res, 500, { error: '服务器内部错误' });
      });
  });
}

// 直接运行 node server.js 时才监听；被测试文件 import 时只导出 createServer。
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const port = Number(process.env.PORT) || 3000;
  const host = '127.0.0.1';
  createServer().listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`包装线归集演示已启动: http://${host}:${port}`);
  });
}
