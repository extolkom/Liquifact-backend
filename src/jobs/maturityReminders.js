'use strict';

const nodemailer = require('nodemailer');
const JobQueue = require('../workers/jobQueue');
const BackgroundWorker = require('../workers/worker');
const {
  maturityReminderDeliveryAttemptsTotal,
  maturityReminderDeadLetterTotal,
  normalizeReminderReason,
  normalizeJobType,
} = require('../metrics');

/**
 * The internal mapping of invoice IDs to job IDs.
 * Allows cancelling a reminder before it fires.
 * @type {Map<string, string>}
 */
const invoiceJobs = new Map();

/**
 * Dead-letter queue for reminders that failed after max retries.
 * Stores { invoiceId, email, error, timestamp, attempts } for debugging/alerting.
 * @type {Array<Object>}
 */
const deadLetterQueue = [];

const emailQueue = new JobQueue();
const emailWorker = new BackgroundWorker({ jobQueue: emailQueue });

/**
 * Nodemailer transport setup.
 * If no real SMTP config is provided, it returns a mock transport (dry-run).
 * @returns {Object} A simulated or real nodemailer transport object.
 */
function getTransport() {
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  // Dry-run / mock transport
  return {
    sendMail: async (mailOptions) => {
      console.log(`[DRY RUN] Sending email to: ${mailOptions.to}`);
      console.log(`[DRY RUN] Subject: ${mailOptions.subject}`);
      console.log(`[DRY RUN] Text: ${mailOptions.text}`);
      return { messageId: 'mock-id-12345', response: '250 OK Mock' };
    }
  };
}

// Templates externalized
const templates = {
  maturityReminder: (customer, amount, targetDate) => `
Dear ${customer},

This is a reminder that your invoice for the amount of $${amount} is maturing on ${targetDate}.
Please ensure funds are prepared for settlement.

Thank you,
LiquiFact Settlement Team
`.trim(),
};

/**
 * Handle sending the email with retry and dead-lettering.
 */
emailWorker.registerHandler('maturity_reminder', async (job) => {
  const { invoiceId, customer, amount, email, targetDate } = job.payload;
  const jobType = normalizeJobType(job.type);

  maturityReminderDeliveryAttemptsTotal.inc({ reason: 'unknown', job_type: jobType });

  try {
    const transport = getTransport();
    const text = templates.maturityReminder(customer, amount, targetDate);

    await transport.sendMail({
      from: process.env.SMTP_FROM || 'noreply@liquifact.com',
      to: email,
      subject: `Settlement Reminder: Invoice ${invoiceId}`,
      text,
    });

    // Since it succeeded, we can clear the job from the map if it hadn't been replaced
    invoiceJobs.delete(invoiceId);
  } catch (err) {
    const reason = normalizeReminderReason(err);
    maturityReminderDeadLetterTotal.inc({ reason, job_type: jobType });
    throw err;
  }
});

/**
 * Schedule a pre-maturity reminder for an invoice.
 * @param {Object} invoice - The invoice metadata.
 * @param {Date} targetDate - When the reminder should actually run.
 * @param {string} email - Destination email.
 * @returns {string} The scheduled job ID.
 */
function scheduleReminder(invoice, targetDate, email) {
  const delayMs = Math.max(targetDate.getTime() - Date.now(), 0);

  const payload = {
    invoiceId: invoice.id,
    customer: invoice.customer,
    amount: invoice.amount,
    email,
    targetDate: targetDate.toISOString(),
  };

  const jobId = emailQueue.enqueue('maturity_reminder', payload, { delayMs });
  
  // Clean up any existing job memory for this invoice first
  if (invoiceJobs.has(invoice.id)) {
    cancelReminder(invoice.id);
  }

  invoiceJobs.set(invoice.id, jobId);
  return jobId;
}

/**
 * Cancels a previously scheduled reminder for an invoice.
 * @param {string} invoiceId - The invoice ID.
 * @returns {boolean} True if successfully canceled, false if not found.
 */
function cancelReminder(invoiceId) {
  const jobId = invoiceJobs.get(invoiceId);
  if (!jobId) {
    return false;
  }

  const canceled = emailQueue.cancel(jobId);
  invoiceJobs.delete(invoiceId);
  return canceled;
}

/**
 * Starts the internal email worker queue processing.
 */
function startQueueProcessing() {
  if (!emailWorker.isRunning) {
    emailWorker.start();
  }
}

/**
 * Stops the internal email worker queue processing gracefully.
 * @param {number} [timeoutMs=5000] - Grace period for pending jobs.
 * @returns {Promise<void>} Resolves when stopped.
 */
async function stopQueueProcessing(timeoutMs = 5000) {
  await emailWorker.stop(timeoutMs);
}

/**
 * Retrieve the dead-letter queue for debugging and manual recovery.
 * @returns {Array<Object>} Copy of dead-lettered reminder entries.
 */
function getDeadLetterQueue() {
  return [...deadLetterQueue];
}

/**
 * Clear the dead-letter queue (after manual recovery/investigation).
 */
function clearDeadLetterQueue() {
  deadLetterQueue.length = 0;
}

module.exports = {
  scheduleReminder,
  cancelReminder,
  startQueueProcessing,
  stopQueueProcessing,
  invoiceJobs,
  emailQueue,
  templates,
  getTransport,
  getDeadLetterQueue,
  clearDeadLetterQueue,
};
