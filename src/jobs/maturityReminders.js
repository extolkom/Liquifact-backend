'use strict';

const nodemailer = require('nodemailer');
const JobQueue = require('../workers/jobQueue');
const BackgroundWorker = require('../workers/worker');
const { sendMailWithRetry, isPermanentSmtpError } = require('../utils/retry');
const logger = require('../logger');
const {
  maturityReminderDeliveryAttemptsTotal,
  maturityReminderDeliverySuccessTotal,
  maturityReminderDeadLetterTotal,
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
  
  const transport = getTransport();
  const text = templates.maturityReminder(customer, amount, targetDate);

  const mailOptions = {
    from: process.env.SMTP_FROM || 'noreply@liquifact.com',
    to: email,
    subject: `Settlement Reminder: Invoice ${invoiceId}`,
    text,
  };

  const maxAttempts = Number(process.env.SMTP_MAX_RETRIES) || 3;

  try {
    // Track attempt
    maturityReminderDeliveryAttemptsTotal.inc({ job_type: 'maturity_reminder' });

    // Send with retry and backoff
    await sendMailWithRetry(transport, mailOptions, {
      maxAttempts,
      baseDelayMs: 1000,
      onRetry: ({ attempt, error }) => {
        logger.warn({
          msg: 'Maturity reminder delivery retry',
          invoiceId,
          email,
          attempt,
          errorCode: error.code,
          errorMessage: error.message,
        });
        
        // Count each retry attempt
        maturityReminderDeliveryAttemptsTotal.inc({ job_type: 'maturity_reminder' });
      },
    });

    // Success
    maturityReminderDeliverySuccessTotal.inc({ job_type: 'maturity_reminder' });
    logger.info({
      msg: 'Maturity reminder delivered successfully',
      invoiceId,
      email,
    });

    // Clean up job mapping
    invoiceJobs.delete(invoiceId);

  } catch (error) {
    const isPermanent = isPermanentSmtpError(error);
    const reason = isPermanent ? 'permanent_error' : 'max_retries_exceeded';

    logger.error({
      msg: 'Maturity reminder delivery failed',
      invoiceId,
      email,
      errorCode: error.code,
      errorMessage: error.message,
      isPermanent,
      reason,
    });

    // Record dead-letter
    maturityReminderDeadLetterTotal.inc({ 
      job_type: 'maturity_reminder',
      reason,
    });

    // Store in dead-letter queue for manual recovery
    deadLetterQueue.push({
      invoiceId,
      email,
      error: {
        code: error.code,
        message: error.message,
        response: error.response,
        isPermanent,
      },
      timestamp: new Date().toISOString(),
      maxAttempts,
    });

    // Limit dead-letter queue size to prevent memory leak
    if (deadLetterQueue.length > 1000) {
      deadLetterQueue.shift();
    }

    // Clean up job mapping
    invoiceJobs.delete(invoiceId);

    // Re-throw so job queue marks job as failed
    throw error;
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
