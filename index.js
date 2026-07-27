const { createClient } = require('@supabase/supabase-js');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function startPolling() {
  console.log("Starting Mailbox Deliverability Poller...");
  setInterval(checkAllMailboxes, 60000); // Poll every 60 seconds
  checkAllMailboxes();
}

async function checkAllMailboxes() {
  const { data: mailboxes, error } = await supabase.from('mailboxes').select('*');
  if (error || !mailboxes) {
    console.error("Error fetching mailboxes:", error);
    return;
  }

  for (const mailbox of mailboxes) {
    if (mailbox.provider === 'gmail') {
      pollGmailIMAP(mailbox);
    }
  }
}

function pollGmailIMAP(mailbox) {
  const imap = new Imap({
    user: mailbox.email,
    password: mailbox.auth_data.password,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });

  imap.once('ready', () => {
    imap.openBox('INBOX', false, (err, box) => {
      if (err) { imap.end(); return; }

      // Search for emails containing "TEST-" in the subject line
      imap.search([['SUBJECT', 'TEST-']], (err, results) => {
        if (err || !results.length) { imap.end(); return; }

        const f = imap.fetch(results, { bodies: '' });
        f.on('message', (msg, seqno) => {
          msg.on('body', (stream, info) => {
            simpleParser(stream, async (err, parsed) => {
              if (err) return;

              // Try to find the Test ID in the subject
              const subject = parsed.subject || "";
              const match = subject.match(/TEST-\d{8}-\d+/); // e.g. TEST-20260727-001
              if (match) {
                const testRunId = match[0];
                await reportResult(testRunId, mailbox.id, 'Inbox');
              }
            });
          });
        });
        f.once('end', () => { imap.end(); });
      });
    });
  });

  imap.once('error', (err) => {
    console.error(`IMAP Error on ${mailbox.email}:`, err.message);
  });

  imap.connect();
}

async function reportResult(testRunId, mailboxId, folder) {
  // Check if this result is already recorded to prevent duplicates
  const { data } = await supabase
    .from('deliverability_results')
    .select('id')
    .eq('test_run_id', testRunId)
    .eq('mailbox_id', mailboxId)
    .limit(1);

  if (data && data.length > 0) return; // Already exists

  // Insert result
  await supabase.from('deliverability_results').insert({
    test_run_id: testRunId,
    mailbox_id: mailboxId,
    folder: folder
  });
  console.log(`Reported: ${testRunId} found in ${folder} for mailbox ${mailboxId}`);
}

startPolling();
