const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReplyRaw } = require('../src/mail');

function decodeBase64Parts(raw) {
  return [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n(?:[^\r\n]+\r\n)*\r\n([A-Za-z0-9+/=\r\n_-]+)/g)]
    .map((match) => Buffer.from(match[1].replace(/\s/g, ''), 'base64').toString('utf8'));
}

function sampleMessage() {
  return {
    subject: '审批申请',
    head_from: { mail_address: 'sender@example.com', name: '发送人' },
    to: [{ mail_address: 'owner@example.com', name: '邮箱主人' }],
    cc: [{ mail_address: 'partner@example.com', name: '协作人' }],
    internal_date: '1783526400000',
    smtp_message_id: '<original@example.com>',
    references: '<earlier@example.com>',
    body_plain_text: '原始文字正文',
    body_html: '<html><body><p>原始<strong>富文本</strong></p><img src="cid:image-1"></body></html>',
    attachments: [
      {
        filename: 'inline.png',
        is_inline: true,
        cid: 'image-1',
        body: Buffer.from('image-bytes').toString('base64'),
      },
      {
        filename: '审批材料.xlsx',
        is_inline: false,
        body: Buffer.from('file-bytes').toString('base64'),
      },
    ],
  };
}

test('回复保留线程、富文本、内嵌图片，并且不重复普通附件', () => {
  const raw = buildReplyRaw({
    message: sampleMessage(),
    mailboxId: 'owner@example.com',
    replyAll: false,
    body: '同意，请处理。',
  });
  const decodedParts = decodeBase64Parts(raw);

  assert.match(raw, /In-Reply-To: <original@example\.com>/);
  assert.match(raw, /References: <earlier@example\.com> <original@example\.com>/);
  assert.match(raw, /Content-Type: multipart\/related/);
  assert.match(raw, /Content-ID: <image-1>/);
  assert.doesNotMatch(raw, /^Cc:/m);
  assert.ok(decodedParts.some((part) => part.includes('原始<strong>富文本</strong>')));
  assert.ok(decodedParts.some((part) => part.includes('审批材料.xlsx（请在原邮件会话中查看）')));
  assert.ok(decodedParts.some((part) => part === 'image-bytes'));
  assert.ok(!decodedParts.some((part) => part === 'file-bytes'));
});

test('回复全部保留抄送人', () => {
  const raw = buildReplyRaw({
    message: sampleMessage(),
    mailboxId: 'owner@example.com',
    replyAll: true,
    body: '同意。',
  });

  assert.match(raw, /^Cc: =\?UTF-8\?B\?.+ <partner@example\.com>$/m);
});
