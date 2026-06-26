'use strict';

const request = require('supertest');
const { createApp } = require('../src/app');
const metrics = require('../src/metrics');
const JobQueue = require('../src/workers/jobQueue');
const BackgroundWorker = require('../src/workers/worker');

describe('GET /metrics', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    metrics.resetMetricsForTests();
    metrics.registry.resetMetrics();
  });

  afterEach(() => {
    delete process.env.METRICS_BEARER_TOKEN;
  });

  describe('METRICS_BEARER_TOKEN configured', () => {
    beforeEach(() => {
      process.env.METRICS_BEARER_TOKEN = 'test-metrics-secret';
    });

    it('returns 200 with Prometheus text when correct token supplied', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer test-metrics-secret');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toMatch(/# HELP/);
    });

    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 401 when token is wrong', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 401 when Authorization scheme is not Bearer', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Basic dXNlcjpwYXNz');
      expect(res.status).toBe(401);
    });
  });

  describe('METRICS_BEARER_TOKEN not configured (private-network mode)', () => {
    it('returns 200 from loopback (supertest uses 127.0.0.1)', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/# HELP/);
    });

    it('includes queue and worker metrics when registered', async () => {
      const queue = new JobQueue();
      const worker = new BackgroundWorker({ jobQueue: queue, pollIntervalMs: 50, maxConcurrency: 1 });
      worker.registerHandler('test', async () => {});

      const jobId = worker.enqueue('test', { data: 'test' });
      const queuedJob = queue.getJob(jobId);
      expect(queuedJob).toBeDefined();

      metrics.refreshMetrics();

      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/liquifact_job_queue_depth/);
      expect(res.text).toMatch(/liquifact_job_retry_queue_size/);
      expect(res.text).toMatch(/liquifact_worker_inflight_count/);
      expect(res.text).toMatch(/liquifact_job_queue_depth \d+/);
    });
  });

  describe('metrics instrumentation', () => {
    it('updates queue depth and retry queue size from job queue stats', () => {
      const queue = new JobQueue();
      const jobId = queue.enqueue('test', { data: 'pending' });
      metrics.registerJobQueue(queue);

      queue.dequeue();
      queue.retry(jobId, new Error('failed'));
      metrics.refreshMetrics();

      const output = metrics.registry.metrics();
      expect(output).toMatch(/liquifact_job_queue_depth \d+/);
      expect(output).toMatch(/liquifact_job_retry_queue_size 1/);
    });

    it('updates worker in-flight count from worker stats', async () => {
      const queue = new JobQueue();
      const worker = new BackgroundWorker({ jobQueue: queue, pollIntervalMs: 50, maxConcurrency: 2 });
      worker.registerHandler('test', async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      worker.start();
      worker.enqueue('test', { data: 1 });
      worker.enqueue('test', { data: 2 });

      await new Promise((resolve) => setTimeout(resolve, 50));
      metrics.refreshMetrics();

      const output = metrics.registry.metrics();
      expect(output).toMatch(/liquifact_worker_inflight_count [12]/);
      await worker.stop();
    });
  });

  describe('metricsAuth unit', () => {
    const { metricsAuth } = require('../src/metrics');

    it('calls next() for loopback when no token configured', () => {
      const req = { headers: {}, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('rejects non-loopback when no token configured', () => {
      const req = { headers: {}, ip: '10.0.0.5', socket: { remoteAddress: '10.0.0.5' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next() for ::1 (IPv6 loopback) when no token configured', () => {
      const req = { headers: {}, ip: '::1', socket: { remoteAddress: '::1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('calls next() for ::ffff:127.0.0.1 when no token configured', () => {
      const req = { headers: {}, ip: '::ffff:127.0.0.1', socket: { remoteAddress: '::ffff:127.0.0.1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('calls next() when correct bearer token is set', () => {
      process.env.METRICS_BEARER_TOKEN = 'secret';
      const req = { headers: { authorization: 'Bearer secret' }, ip: '10.0.0.1', socket: {} };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
      delete process.env.METRICS_BEARER_TOKEN;
    });

    it('falls back to socket.remoteAddress when req.ip is empty', () => {
      const req = { headers: {}, ip: '', socket: { remoteAddress: '127.0.0.1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 401 when both req.ip and socket.remoteAddress are absent', () => {
      const req = { headers: {}, ip: undefined, socket: {} };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
