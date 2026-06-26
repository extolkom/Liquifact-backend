const {
  scheduleReminder,
  cancelReminder,
  startQueueProcessing,
  stopQueueProcessing,
  invoiceJobs,
  emailQueue,
  templates,
  getTransport
} = require('../src/jobs/maturityReminders');

const {
  normalizeReminderReason,
  normalizeJobType,
  REMINDER_REASON_ENUM,
  JOB_TYPE_ENUM,
  maturityReminderDeliveryAttemptsTotal,
  maturityReminderDeadLetterTotal,
  registry,
} = require('../src/metrics');

describe('Maturity Reminders Job', () => {
  beforeEach(() => {
    emailQueue.clear();
    invoiceJobs.clear();
    jest.clearAllMocks();
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;
  });

  afterAll(async () => {
    await stopQueueProcessing(100);
  });

  describe('getTransport and execution', () => {
    it('returns a mock transport when SMTP_HOST is not set', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const transport = getTransport();
      
      const res = await transport.sendMail({
        to: 'test@example.com',
        subject: 'Test',
        text: 'Hello test'
      });
      
      expect(res.response).toBe('250 OK Mock');
      expect(consoleSpy).toHaveBeenCalledWith('[DRY RUN] Sending email to: test@example.com');
      consoleSpy.mockRestore();
    });

    it('returns a nodemailer transport when SMTP_HOST is set', () => {
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_PORT = '587';
      process.env.SMTP_USER = 'user';
      process.env.SMTP_PASS = 'pass';
      
      const transport = getTransport();
      expect(transport.sendMail).toBeDefined();
      expect(transport.options).toBeDefined();
      expect(transport.options.host).toBe('smtp.example.com');
      expect(transport.options.port).toBe(587);
    });

    it('returns a nodemailer transport when SMTP_HOST is set but port defaults', () => {
      process.env.SMTP_HOST = 'smtp.example.com';
      delete process.env.SMTP_PORT;
      
      const transport = getTransport();
      expect(transport.options.port).toBe(587);
    });
  });

  describe('templates', () => {
    it('generates a maturity reminder template correctly', () => {
      const text = templates.maturityReminder('Acme Corp', 5000, '2027-01-01');
      expect(text).toContain('Dear Acme Corp');
      expect(text).toContain('$5000');
      expect(text).toContain('2027-01-01');
    });
  });

  describe('scheduleReminder and cancelReminder', () => {
    it('schedules a reminder correctly', () => {
      const invoice = { id: 'inv_123', customer: 'Acme', amount: 300 };
      const targetDate = new Date(Date.now() + 10000); // 10s from now
      
      const jobId = scheduleReminder(invoice, targetDate, 'acme@example.com');
      
      expect(jobId).toBeDefined();
      expect(invoiceJobs.get('inv_123')).toBe(jobId);
      
      const job = emailQueue.getJob(jobId);
      expect(job.type).toBe('maturity_reminder');
      expect(job.payload.email).toBe('acme@example.com');
      expect(job.delayMs).toBeGreaterThan(0);
    });

    it('clears previous job if rescheduling for the same invoice', () => {
      const invoice = { id: 'inv_123', customer: 'Acme', amount: 300 };
      const targetDate = new Date(Date.now() + 10000);
      
      const jobId1 = scheduleReminder(invoice, targetDate, 'acme@example.com');
      const jobId2 = scheduleReminder(invoice, targetDate, 'acme@example.com');
      
      expect(jobId1).not.toBe(jobId2);
      expect(invoiceJobs.get('inv_123')).toBe(jobId2);
      
      expect(emailQueue.getJob(jobId1)).toBeNull();
    });

    it('cancels a scheduled reminder', () => {
      const invoice = { id: 'inv_456', customer: 'Acme', amount: 300 };
      const targetDate = new Date(Date.now() + 10000);
      
      const jobId = scheduleReminder(invoice, targetDate, 'acme@example.com');
      expect(invoiceJobs.has('inv_456')).toBe(true);
      
      const canceled = cancelReminder('inv_456');
      
      expect(canceled).toBe(true);
      expect(invoiceJobs.has('inv_456')).toBe(false);
      expect(emailQueue.getJob(jobId)).toBeNull();
    });

    it('returns false when cancelling unknown invoice id', () => {
      const canceled = cancelReminder('unknown_id');
      expect(canceled).toBe(false);
    });
  });

  describe('queue processing', () => {
    it('processes a maturity_reminder job', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      
      const invoice = { id: 'inv_test_email', customer: 'Bob', amount: 1000 };
      const targetDate = new Date(Date.now() - 1000); // Past so delay=0
      
      scheduleReminder(invoice, targetDate, 'bob@example.com');
      
      startQueueProcessing();
      
      await new Promise(resolve => setTimeout(resolve, 200));
      await stopQueueProcessing(100);
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[DRY RUN] Sending email to: bob@example.com'));
      expect(invoiceJobs.has('inv_test_email')).toBe(false);
      
      consoleSpy.mockRestore();
    });

    it('processes a maturity_reminder job and skips if SMTP_FROM is set', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      process.env.SMTP_FROM = 'support@liquifact.com';

      const invoice = { id: 'inv_test_email2', customer: 'Bob2', amount: 1000 };
      const targetDate = new Date(Date.now() - 1000); 
      
      scheduleReminder(invoice, targetDate, 'bob2@example.com');
      
      startQueueProcessing();
      
      await new Promise(resolve => setTimeout(resolve, 200));
      await stopQueueProcessing(100);
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[DRY RUN] Sending email to: bob2@example.com'));
      expect(invoiceJobs.has('inv_test_email2')).toBe(false);
      
      consoleSpy.mockRestore();
    });
    
    it('starts queue processing without crashing if already running', () => {
      startQueueProcessing();
      startQueueProcessing(); // Should just return
      stopQueueProcessing(100);
    });
  });
});

// ── #420: normalizeReminderReason / normalizeJobType coverage ─────────────────

describe('normalizeReminderReason', () => {
  it('returns every value in REMINDER_REASON_ENUM for known inputs', () => {
    expect(REMINDER_REASON_ENUM).toContain('smtp_timeout');
    expect(REMINDER_REASON_ENUM).toContain('smtp_reject');
    expect(REMINDER_REASON_ENUM).toContain('template_error');
    expect(REMINDER_REASON_ENUM).toContain('unknown');
  });

  it('maps timeout errors', () => {
    expect(normalizeReminderReason('Connection timeout')).toBe('smtp_timeout');
    expect(normalizeReminderReason('ETIMEDOUT waiting for server')).toBe('smtp_timeout');
    expect(normalizeReminderReason('ECONNREFUSED port 587')).toBe('smtp_timeout');
    expect(normalizeReminderReason('ECONNRESET by peer')).toBe('smtp_timeout');
    expect(normalizeReminderReason(new Error('connect ECONNREFUSED 127.0.0.1:587'))).toBe('smtp_timeout');
  });

  it('maps SMTP reject errors', () => {
    expect(normalizeReminderReason('550 User unknown')).toBe('smtp_reject');
    expect(normalizeReminderReason('554 rejected by policy')).toBe('smtp_reject');
    expect(normalizeReminderReason('Message rejected')).toBe('smtp_reject');
    expect(normalizeReminderReason('EAUTH authentication failed')).toBe('smtp_reject');
  });

  it('maps template errors', () => {
    expect(normalizeReminderReason('template rendering failed')).toBe('template_error');
    expect(normalizeReminderReason('Template missing variable')).toBe('template_error');
  });

  it('returns unknown for empty/null/non-string inputs', () => {
    expect(normalizeReminderReason('')).toBe('unknown');
    expect(normalizeReminderReason(null)).toBe('unknown');
    expect(normalizeReminderReason(undefined)).toBe('unknown');
    expect(normalizeReminderReason(42)).toBe('unknown');
    expect(normalizeReminderReason({})).toBe('unknown');
  });

  it('returns unknown for unmapped errors', () => {
    expect(normalizeReminderReason('some completely unrelated error')).toBe('unknown');
    expect(normalizeReminderReason('X'.repeat(10000))).toBe('unknown');
  });

  it('does not leak PII — raw string never returned', () => {
    const rawWithPii = 'SMTP error for user@company.com: 550 reject';
    const result = normalizeReminderReason(rawWithPii);
    expect(REMINDER_REASON_ENUM).toContain(result);
    // Result must be a bounded enum value, never the raw string
    expect(result).not.toBe(rawWithPii);
  });
});

describe('normalizeJobType', () => {
  it('passes through valid job types', () => {
    JOB_TYPE_ENUM.forEach((type) => {
      expect(normalizeJobType(type)).toBe(type);
    });
  });

  it('maps unknown/non-string inputs to "unknown"', () => {
    expect(normalizeJobType('not_a_real_job')).toBe('unknown');
    expect(normalizeJobType('')).toBe('unknown');
    expect(normalizeJobType(null)).toBe('unknown');
    expect(normalizeJobType(undefined)).toBe('unknown');
  });
});

describe('maturity-reminder metric counters', () => {
  it('counters are registered with the shared registry', async () => {
    const metrics = await registry.metrics();
    expect(metrics).toContain('maturity_reminder_delivery_attempts_total');
    expect(metrics).toContain('maturity_reminder_dead_letter_total');
  });

  it('delivery attempts counter increments with bounded labels', () => {
    const before = maturityReminderDeliveryAttemptsTotal.hashMap;
    maturityReminderDeliveryAttemptsTotal.inc({ reason: 'unknown', job_type: 'maturity_reminder' });
    // Counter accepts valid bounded labels without throwing
    const after = maturityReminderDeliveryAttemptsTotal.hashMap;
    expect(after).toBeDefined();
    // hashMap has the label key set
    const key = Object.keys(after).find((k) => k.includes('maturity_reminder'));
    expect(key).toBeDefined();
  });

  it('dead letter counter increments with bounded labels', () => {
    maturityReminderDeadLetterTotal.inc({ reason: 'smtp_timeout', job_type: 'maturity_reminder' });
    const after = maturityReminderDeadLetterTotal.hashMap;
    const key = Object.keys(after).find((k) => k.includes('smtp_timeout'));
    expect(key).toBeDefined();
  });
});
