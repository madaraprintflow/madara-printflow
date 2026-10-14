import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, PageSizes, rgb } from 'pdf-lib';

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

const PORT = Number(process.env.PORT || 8080);
const MAX_PDFS_PER_JOB = Number(process.env.MAX_PDFS_PER_JOB || 2500);

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'Missing required environment variables: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY'
  );
  process.exit(1);
}

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const app = express();
app.disable('x-powered-by');

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'MADARA PRINTFLOW PDF worker' });
});

async function authorizeAdmin(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!token) {
    throw new Error('Sign in as an administrator to process PDF batches.');
  }

  const { data: userData, error: userError } =
    await anonClient.auth.getUser(token);

  if (userError || !userData?.user) {
    throw new Error('Your session is invalid or expired. Please sign in again.');
  }

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('id,role,is_active')
    .eq('id', userData.user.id)
    .single();

  if (
    profileError ||
    !profile ||
    profile.role !== 'admin' ||
    !profile.is_active
  ) {
    throw new Error('Administrator permission is required.');
  }

  return profile;
}

function safeOutputPath(id) {
  return `submissions/${id}/print-ready.pdf`;
}

async function setFailed(id, message) {
  await adminClient
    .from('submissions')
    .update({
      status: 'failed',
      notes: String(message).slice(0, 1500),
      updated_at: new Date().toISOString()
    })
    .eq('id', id);
}

/*
 * Draw crop marks outside each card's artwork.
 * Marks indicate cutting positions without covering card content.
 */
function drawCropMarks(page, x, y, width, height, color) {
  const markLength = 5;
  const inset = 1.5;
  const thickness = 0.45;

  const left = x;
  const right = x + width;
  const bottom = y;
  const top = y + height;

  const line = (start, end) => {
    page.drawLine({ start, end, thickness, color });
  };

  // Bottom-left
  line(
    { x: left - inset - markLength, y: bottom },
    { x: left - inset, y: bottom }
  );
  line(
    { x: left, y: bottom - inset - markLength },
    { x: left, y: bottom - inset }
  );

  // Bottom-right
  line(
    { x: right + inset, y: bottom },
    { x: right + inset + markLength, y: bottom }
  );
  line(
    { x: right, y: bottom - inset - markLength },
    { x: right, y: bottom - inset }
  );

  // Top-left
  line(
    { x: left - inset - markLength, y: top },
    { x: left - inset, y: top }
  );
  line(
    { x: left, y: top + inset },
    { x: left, y: top + inset + markLength }
  );

  // Top-right
  line(
    { x: right + inset, y: top },
    { x: right + inset + markLength, y: top }
  );
  line(
    { x: right, y: top + inset },
    { x: right, y: top + inset + markLength }
  );
}

async function buildPrintPdf(submissionId) {
  const { data: submission, error: subError } = await adminClient
    .from('submissions')
    .select('id,reference_code,status,card_count')
    .eq('id', submissionId)
    .single();

  if (subError || !submission) {
    throw new Error('Submission was not found.');
  }

  const { data: files, error: filesError } = await adminClient
    .from('submission_files')
    .select('id,original_name,storage_path,file_size_bytes')
    .eq('submission_id', submissionId)
    .order('created_at', { ascending: true });

  if (filesError) throw filesError;

  if (!files?.length) {
    throw new Error('There are no PDF files attached to this submission.');
  }

  if (files.length > MAX_PDFS_PER_JOB) {
    throw new Error(
      `This job has ${files.length} PDFs; the configured limit is ${MAX_PDFS_PER_JOB}. Split it into smaller batches.`
    );
  }

  const out = await PDFDocument.create();

  out.setTitle(`MADARA PRINTFLOW - ${submission.reference_code}`);
  out.setSubject('Four cards per A4 sheet with cutting guides');
  out.setCreator('MADARA PRINTFLOW');

  // Standard A4 portrait: 210 × 297 mm.
  const [pageW, pageH] = PageSizes.A4;

  // Layout: four cards per A4 sheet.
  // The central gap allows cutting marks and spacing.
  const margin = 10; // points, approximately 3.5 mm
  const gap = 18;    // points, approximately 6.35 mm

  const cellW = (pageW - margin * 2 - gap) / 2;
  const cellH = (pageH - margin * 2 - gap) / 2;

  const cropColor = rgb(0.25, 0.25, 0.25);
  let placed = 0;

  for (const fileRow of files) {
    const { data: fileData, error: downloadError } =
      await adminClient.storage
        .from('printflow-originals')
        .download(fileRow.storage_path);

    if (downloadError || !fileData) {
      throw new Error(
        `Could not download ${fileRow.original_name}: ${
          downloadError?.message || 'file unavailable'
        }`
      );
    }

    const sourceBytes = await fileData.arrayBuffer();
    let source;

    try {
      source = await PDFDocument.load(sourceBytes, {
        ignoreEncryption: false
      });
    } catch {
      throw new Error(
        `The file "${fileRow.original_name}" is not a readable PDF or is password-protected.`
      );
    }

    if (!source.getPageCount()) {
      throw new Error(
        `The file "${fileRow.original_name}" contains no pages.`
      );
    }

    // Each uploaded PDF represents one card; use its first page.
    const [embedded] = await out.embedPages([source.getPages()[0]]);

    const idx = placed % 4;

    if (idx === 0) {
      out.addPage([pageW, pageH]);
    }

    const page = out.getPages()[out.getPageCount() - 1];

    const col = idx % 2;
    const row = Math.floor(idx / 2);

    const cellX = margin + col * (cellW + gap);
    const cellTop = pageH - margin - row * (cellH + gap);

    // Maximize the card size while preserving its aspect ratio.
    // This prevents stretching or distortion.
    const scale = Math.min(
      cellW / embedded.width,
      cellH / embedded.height
    );

    const drawW = embedded.width * scale;
    const drawH = embedded.height * scale;

    const x = cellX + (cellW - drawW) / 2;
    const y = cellTop - cellH + (cellH - drawH) / 2;

    page.drawPage(embedded, {
      x,
      y,
      width: drawW,
      height: drawH
    });

    drawCropMarks(page, x, y, drawW, drawH, cropColor);

    placed++;
  }

  const bytes = await out.save({ useObjectStreams: true });
  const path = safeOutputPath(submissionId);

  const { error: uploadError } = await adminClient.storage
    .from('printflow-output')
    .upload(path, bytes, {
      contentType: 'application/pdf',
      upsert: true
    });

  if (uploadError) {
    throw new Error(
      `Could not save print-ready PDF: ${uploadError.message}`
    );
  }

  const { error: updateError } = await adminClient
    .from('submissions')
    .update({
      status: 'ready',
      output_path: path,
      output_card_count: placed,
