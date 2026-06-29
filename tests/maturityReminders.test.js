'use strict';

const mockDeliveryAttempts = { inc: jest.fn() };
const mockDeadLetters = { inc: jest.fn() };
const mockLogger = { warn: jest.fn() };
const mockCreateTransport = jest.fn((options) => ({
  options,
  sendMail: jest.fn(),
}));

jest.mock('nodemailer', () => ({ createTransport: mockCreateTransport }), { virtual: true });
jest.mock('../src/db/knex', () => jest.fn());
jest.mock('../src/logger', () => mockLogger);
jest.mock('../src/metrics', () => ({
  registerJobQueue: jest.fn(),
  registerWorker: jest.fn(),
  maturityReminderDeliveryAttemptsTotal: mockDeliveryAttempts,
  maturityReminderDeadLetterTotal: mockDeadLetters,
  normalizeJobType: jest.fn((value) => value === 'maturity_reminder' ? value : 'unknown'),
  normalizeReminderReason: jest.fn((error) => {
    const message = error && error.message ? error.message : '';
    if (/timeout|ETIMEDOUT/i.test(message)) {
      return 'smtp_timeout';
    }
    if (/reject|550/i.test(message)) {
      return 'smtp_reject';
    }
    return 'unknown';
  }),
}));

const {
  scheduleReminder,
  cancelReminder,
  startQueueProcessing,
  stopQueueProcessing,
  invoiceJobs,
  emailQueue,
  emailWorker,
  templates,
  getTransport,
  getMaxAttempts,
  createMaturityReminderHandler,
  persistReminderDeadLetter,
  listReminderDeadLetters,
} = require('../src/jobs/maturityReminders');
const defaultDb = require('../src/db/knex');

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createListDb(rows = []) {
  const query = {
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return { db: jest.fn(() => query), query };
}

describe('maturity reminder dead-letter persistence', () => {
  beforeEach(async () => {
    if (emailWorker.isRunning) {
      await stopQueueProcessing(100);
    }
    emailQueue.clear();
    invoiceJobs.clear();
    jest.clearAllMocks();
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;
    delete process.env.SMTP_MAX_RETRIES;
  });

  afterAll(async () => {
    await stopQueueProcessing();
  });

  describe('transport, template, and retry configuration', () => {
    it('uses a dry-run transport without SMTP configuration', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const result = await getTransport().sendMail({
        to: 'operator@example.com',
        subject: 'subject',
        text: 'body',
      });

      expect(result.response).toBe('250 OK Mock');
      expect(consoleSpy).toHaveBeenCalledTimes(3);
      consoleSpy.mockRestore();
    });

    it('creates a configured SMTP transport and defaults its port', () => {
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_USER = 'user';
      process.env.SMTP_PASS = 'pass';

      expect(getTransport().options).toMatchObject({
        host: 'smtp.example.com',
        port: 587,
      });

      process.env.SMTP_PORT = '2525';
      expect(getTransport().options.port).toBe(2525);
    });

    it('renders the reminder template', () => {
      const rendered = templates.maturityReminder('Alice', 1000, '2026-07-01');
      expect(rendered).toContain('Alice');
      expect(rendered).toContain('$1000');
      expect(rendered).toContain('2026-07-01');
    });

    it('bounds configured SMTP attempts', () => {
      expect(getMaxAttempts()).toBe(3);

      process.env.SMTP_MAX_RETRIES = 'invalid';
      expect(getMaxAttempts()).toBe(3);

      process.env.SMTP_MAX_RETRIES = '0';
      expect(getMaxAttempts()).toBe(1);

      process.env.SMTP_MAX_RETRIES = '20';
      expect(getMaxAttempts()).toBe(10);

      process.env.SMTP_MAX_RETRIES = '4.9';
      expect(getMaxAttempts()).toBe(4);
    });
  });

  describe('scheduling', () => {
    it('schedules, replaces, and cancels reminders by invoice', () => {
      const invoice = { id: 'inv-1', customer: 'Alice', amount: 100 };
      const first = scheduleReminder(invoice, new Date(Date.now() + 5000), 'alice@example.com');
      const second = scheduleReminder(invoice, new Date(Date.now() + 6000), 'alice@example.com');

      expect(second).not.toBe(first);
      expect(emailQueue.getJob(first)).toBeNull();
      expect(invoiceJobs.get(invoice.id)).toBe(second);
      expect(cancelReminder(invoice.id)).toBe(true);
      expect(invoiceJobs.has(invoice.id)).toBe(false);
      expect(cancelReminder('missing')).toBe(false);
    });

    it('starts and stops queue processing idempotently', async () => {
      startQueueProcessing();
      startQueueProcessing();
      expect(emailWorker.isRunning).toBe(true);

      await stopQueueProcessing(100);
      expect(emailWorker.isRunning).toBe(false);
    });
  });

  describe('database helpers', () => {
    it('uses the shared database defaults for writes and reads', async () => {
      const insert = jest.fn().mockResolvedValue();
      defaultDb.mockReturnValueOnce({ insert });
      await persistReminderDeadLetter({
        jobId: 'job-default',
        invoiceId: 'inv-default',
        jobType: 'maturity_reminder',
        reason: 'unknown',
        attempts: 0,
        targetDate: '2026-07-01T00:00:00.000Z',
      });
      expect(insert).toHaveBeenCalledTimes(1);

      const { query } = createListDb([]);
      defaultDb.mockReturnValueOnce(query);
      await expect(listReminderDeadLetters()).resolves.toEqual([]);
    });

    it('persists only allowlisted operational metadata', async () => {
      const insert = jest.fn().mockResolvedValue();
      const dbClient = jest.fn(() => ({ insert }));

      await persistReminderDeadLetter({
        jobId: 'job-1',
        invoiceId: 'inv-1',
        jobType: 'maturity_reminder',
        reason: 'smtp_timeout',
        attempts: 3,
        targetDate: '2026-07-01T00:00:00.000Z',
        email: 'must-not-persist@example.com',
        customer: 'Must Not Persist',
        amount: 999,
        body: 'private email body',
      }, dbClient);

      expect(dbClient).toHaveBeenCalledWith('maturity_reminder_dead_letters');
      expect(insert).toHaveBeenCalledWith(expect.objectContaining({
        job_id: 'job-1',
        invoice_id: 'inv-1',
        reason: 'smtp_timeout',
        attempts: 3,
      }));

      const stored = insert.mock.calls[0][0];
      expect(JSON.parse(stored.payload_metadata)).toEqual({
        jobType: 'maturity_reminder',
        targetDate: '2026-07-01T00:00:00.000Z',
      });
      expect(JSON.stringify(stored)).not.toContain('must-not-persist');
      expect(JSON.stringify(stored)).not.toContain('private email body');
      expect(JSON.stringify(stored)).not.toContain('999');
    });

    it('returns an empty persisted list after a restart-equivalent read', async () => {
      const { db, query } = createListDb([]);

      await expect(listReminderDeadLetters({}, db)).resolves.toEqual([]);
      expect(db).toHaveBeenCalledWith('maturity_reminder_dead_letters');
      expect(query.orderBy).toHaveBeenCalledWith('created_at', 'desc');
      expect(query.limit).toHaveBeenCalledWith(50);
      expect(query.where).not.toHaveBeenCalled();
    });

    it('lists stored rows with bounded limit and an optional reason', async () => {
      const rows = [{ id: 'dl-1', reason: 'smtp_reject' }];
      const { db, query } = createListDb(rows);

      await expect(listReminderDeadLetters({ limit: 999, reason: 'smtp_reject' }, db))
        .resolves.toEqual(rows);
      expect(query.limit).toHaveBeenCalledWith(200);
      expect(query.where).toHaveBeenCalledWith('reason', 'smtp_reject');
    });

    it('normalizes invalid and low list limits', async () => {
      const first = createListDb();
      await listReminderDeadLetters({ limit: 0 }, first.db);
      expect(first.query.limit).toHaveBeenCalledWith(1);

      const second = createListDb();
      await listReminderDeadLetters({ limit: 'not-a-number' }, second.db);
      expect(second.query.limit).toHaveBeenCalledWith(50);
    });
  });

  describe('delivery handler', () => {
    function job(overrides = {}) {
      return {
        id: 'job-42',
        type: 'maturity_reminder',
        payload: {
          invoiceId: 'inv-42',
          customer: 'Alice',
          amount: 500,
          email: 'alice@example.com',
          targetDate: '2026-07-01T00:00:00.000Z',
          ...overrides,
        },
      };
    }

    it('delivers successfully without persisting a dead letter', async () => {
      const sendMail = jest.fn().mockResolvedValue({ messageId: 'sent' });
      const persistDeadLetter = jest.fn();
      const handler = createMaturityReminderHandler({
        transportFactory: () => ({ sendMail }),
        persistDeadLetter,
      });
      invoiceJobs.set('inv-42', 'job-42');

      await handler(job());

      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
        to: 'alice@example.com',
        subject: 'Settlement Reminder: Invoice inv-42',
      }));
      expect(mockDeliveryAttempts.inc).toHaveBeenCalledTimes(1);
      expect(mockDeadLetters.inc).not.toHaveBeenCalled();
      expect(persistDeadLetter).not.toHaveBeenCalled();
      expect(invoiceJobs.has('inv-42')).toBe(false);
    });

    it('persists one sanitized record after transient retries are exhausted', async () => {
      process.env.SMTP_MAX_RETRIES = '2';
      const error = new Error('ETIMEDOUT while connecting');
      const sendMail = jest.fn().mockRejectedValue(error);
      const persistDeadLetter = jest.fn().mockResolvedValue();
      const handler = createMaturityReminderHandler({
        transportFactory: () => ({ sendMail }),
        persistDeadLetter,
      });

      await handler(job());
      await flushPromises();

      expect(sendMail).toHaveBeenCalledTimes(2);
      expect(mockDeliveryAttempts.inc).toHaveBeenCalledTimes(2);
      expect(mockDeadLetters.inc).toHaveBeenCalledWith({
        reason: 'smtp_timeout',
        job_type: 'maturity_reminder',
      });
      expect(persistDeadLetter).toHaveBeenCalledTimes(1);
      expect(persistDeadLetter).toHaveBeenCalledWith({
        jobId: 'job-42',
        invoiceId: 'inv-42',
        jobType: 'maturity_reminder',
        reason: 'smtp_timeout',
        attempts: 2,
        targetDate: '2026-07-01T00:00:00.000Z',
      });
    }, 5000);

    it('dead-letters permanent SMTP failures after one attempt', async () => {
      process.env.SMTP_MAX_RETRIES = '5';
      const permanentError = new Error('550 rejected');
      permanentError.response = '550 rejected';
      const persistDeadLetter = jest.fn().mockResolvedValue();
      const handler = createMaturityReminderHandler({
        transportFactory: () => ({ sendMail: jest.fn().mockRejectedValue(permanentError) }),
        persistDeadLetter,
      });

      await handler(job());
      await flushPromises();

      expect(persistDeadLetter).toHaveBeenCalledWith(expect.objectContaining({
        reason: 'smtp_reject',
        attempts: 1,
      }));
    });

    it('does not block the reminder loop on a slow persistence call', async () => {
      process.env.SMTP_MAX_RETRIES = '1';
      let finishPersistence;
      const persistDeadLetter = jest.fn(() => new Promise((resolve) => {
        finishPersistence = resolve;
      }));
      const handler = createMaturityReminderHandler({
        transportFactory: () => ({ sendMail: jest.fn().mockRejectedValue(new Error('timeout')) }),
        persistDeadLetter,
      });

      await handler(job());
      await flushPromises();

      expect(persistDeadLetter).toHaveBeenCalledTimes(1);
      finishPersistence();
      await flushPromises();
    });

    it('logs persistence failures without rejecting the reminder handler', async () => {
      process.env.SMTP_MAX_RETRIES = '1';
      const handler = createMaturityReminderHandler({
        transportFactory: () => ({ sendMail: jest.fn().mockRejectedValue(new Error('timeout')) }),
        persistDeadLetter: jest.fn().mockRejectedValue(new Error('database unavailable')),
      });

      await expect(handler(job())).resolves.toBeUndefined();
      await flushPromises();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { err: 'database unavailable', jobId: 'job-42' },
        'Failed to persist maturity-reminder dead letter'
      );
    });

    it('safely stringifies non-error persistence rejections', async () => {
      process.env.SMTP_MAX_RETRIES = '1';
      const handler = createMaturityReminderHandler({
        transportFactory: () => ({ sendMail: jest.fn().mockRejectedValue(new Error('timeout')) }),
        persistDeadLetter: jest.fn().mockRejectedValue('offline'),
      });

      await handler(job());
      await flushPromises();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { err: 'offline', jobId: 'job-42' },
        'Failed to persist maturity-reminder dead letter'
      );
    });

    it('records setup failures without leaking their raw details', async () => {
      const persistDeadLetter = jest.fn().mockResolvedValue();
      const handler = createMaturityReminderHandler({
        transportFactory: () => {
          throw new Error('credentials failed for alice@example.com');
        },
        persistDeadLetter,
      });

      await handler(job());
      await flushPromises();

      expect(persistDeadLetter).toHaveBeenCalledWith(expect.objectContaining({
        attempts: 0,
        reason: 'unknown',
      }));
      expect(JSON.stringify(persistDeadLetter.mock.calls[0][0])).not.toContain('alice@example.com');
    });
  });
});
