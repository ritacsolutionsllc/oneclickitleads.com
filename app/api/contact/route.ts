import { NextResponse } from 'next/server';
import { Resend } from 'resend';

const CONTACT_TO = process.env.CONTACT_EMAIL_TO ?? 'contact@oneclickit.ai';
const CONTACT_FROM = process.env.CONTACT_EMAIL_FROM ?? 'OneClickitLeads <noreply@oneclickit.ai>';

type Body = {
  name?: string;
  email?: string;
  company?: string;
  subject?: string;
  message?: string;
  kind?: 'contact' | 'dsar';
  dsarType?: 'access' | 'delete' | 'optout' | 'correct';
  hp?: string;
};

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  return new Resend(key);
}

const DSAR_TYPES = ['access', 'delete', 'correct', 'optout'] as const;
type DsarType = (typeof DSAR_TYPES)[number];

function isDsarType(v: unknown): v is DsarType {
  return typeof v === 'string' && (DSAR_TYPES as readonly string[]).includes(v);
}

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (body.hp) return NextResponse.json({ ok: true });

  const name = (body.name ?? '').trim().slice(0, 200);
  const email = (body.email ?? '').trim().slice(0, 320);
  const company = (body.company ?? '').trim().slice(0, 200);
  const subject = (body.subject ?? '').trim().slice(0, 200);
  const message = (body.message ?? '').trim().slice(0, 5000);
  const kind = body.kind === 'dsar' ? 'dsar' : 'contact';
  const dsarType: DsarType | undefined = isDsarType(body.dsarType) ? body.dsarType : undefined;

  if (!email || !isEmail(email)) {
    return NextResponse.json({ error: 'valid email required' }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ error: 'message required' }, { status: 400 });
  }
  if (kind === 'dsar' && !dsarType) {
    return NextResponse.json(
      { error: `dsarType must be one of: ${DSAR_TYPES.join(', ')}` },
      { status: 400 },
    );
  }

  const subjectLine =
    kind === 'dsar'
      ? `[DSAR:${dsarType}] ${name || email}`
      : `[Contact] ${subject || 'New message'} — ${name || email}`;

  const rows: Array<[string, string]> = [
    ['Kind', kind],
    ...(dsarType ? ([['DSAR type', dsarType]] as Array<[string, string]>) : []),
    ['Name', name || '(not provided)'],
    ['Email', email],
    ['Company', company || '(not provided)'],
    ['Subject', subject || '(not provided)'],
  ];

  const html = `
    <h2 style="font:600 16px system-ui">${escapeHtml(subjectLine)}</h2>
    <table cellpadding="6" style="font:14px system-ui;border-collapse:collapse">
      ${rows
        .map(
          ([k, v]) =>
            `<tr><td style="color:#666">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`,
        )
        .join('')}
    </table>
    <hr />
    <pre style="font:14px/1.5 system-ui;white-space:pre-wrap">${escapeHtml(message)}</pre>
  `;

  try {
    await getResend().emails.send({
      from: CONTACT_FROM,
      to: CONTACT_TO,
      replyTo: email,
      subject: subjectLine,
      html,
    });
  } catch (err) {
    console.error('[contact] send failed', err);
    return NextResponse.json({ error: 'send failed' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
