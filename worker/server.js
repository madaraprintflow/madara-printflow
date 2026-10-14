import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, PageSizes } from 'pdf-lib';

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const PORT = Number(process.env.PORT || 8080);
const MAX_PDFS_PER_JOB = Number(process.env.MAX_PDFS_PER_JOB || 2500);
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing required environment variables: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession:false, autoRefreshToken:false } });
const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession:false, autoRefreshToken:false } });
const app = express();
app.disable('x-powered-by');
app.use(cors({ origin:true, methods:['GET','POST','OPTIONS'], allowedHeaders:['Content-Type','Authorization'] }));
app.use(express.json({ limit:'1mb' }));
app.get('/health', (_req,res) => res.json({ ok:true, service:'MADARA PRINTFLOW PDF worker' }));

async function authorizeAdmin(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw new Error('Sign in as an administrator to process PDF batches.');
  const { data: userData, error: userError } = await anonClient.auth.getUser(token);
  if (userError || !userData?.user) throw new Error('Your session is invalid or expired. Please sign in again.');
  const { data: profile, error: profileError } = await adminClient.from('profiles').select('id,role,is_active').eq('id', userData.user.id).single();
  if (profileError || !profile || profile.role !== 'admin' || !profile.is_active) throw new Error('Administrator permission is required.');
  return profile;
}

function safeOutputPath(id) { return `submissions/${id}/print-ready.pdf`; }
async function setFailed(id, message) {
  await adminClient.from('submissions').update({ status:'failed', notes:String(message).slice(0,1500), updated_at:new Date().toISOString() }).eq('id',id);
}

async function buildPrintPdf(submissionId) {
  const { data: submission, error: subError } = await adminClient.from('submissions').select('id,reference_code,status,card_count').eq('id',submissionId).single();
  if (subError || !submission) throw new Error('Submission was not found.');
  const { data: files, error: filesError } = await adminClient.from('submission_files').select('id,original_name,storage_path,file_size_bytes').eq('submission_id',submissionId).order('created_at',{ascending:true});
  if (filesError) throw filesError;
  if (!files?.length) throw new Error('There are no PDF files attached to this submission.');
  if (files.length > MAX_PDFS_PER_JOB) throw new Error(`This job has ${files.length} PDFs; the configured limit is ${MAX_PDFS_PER_JOB}. Split it into smaller batches.`);

  const out = await PDFDocument.create();
  out.setTitle(`MADARA PRINTFLOW - ${submission.reference_code}`);
  out.setSubject('Four cards per A4 sheet');
  out.setCreator('MADARA PRINTFLOW');
  const [pageW,pageH] = PageSizes.A4;
  const margin = 22; const gap = 12;
  const cellW = (pageW - margin * 2 - gap) / 2;
  const cellH = (pageH - margin * 2 - gap) / 2;
  let placed = 0;
  for (const fileRow of files) {
    const { data: fileData, error: downloadError } = await adminClient.storage.from('printflow-originals').download(fileRow.storage_path);
    if (downloadError || !fileData) throw new Error(`Could not download ${fileRow.original_name}: ${downloadError?.message || 'file unavailable'}`);
    const sourceBytes = await fileData.arrayBuffer();
    let source;
    try { source = await PDFDocument.load(sourceBytes, { ignoreEncryption:false }); }
    catch { throw new Error(`The file "${fileRow.original_name}" is not a readable PDF or is password-protected.`); }
    if (!source.getPageCount()) throw new Error(`The file "${fileRow.original_name}" contains no pages.`);
    // Each uploaded PDF represents one card. Only its first page is used.
    const [embedded] = await out.embedPages([source.getPages()[0]]);
    const idx = placed % 4;
    if (idx === 0) out.addPage([pageW,pageH]);
    const page = out.getPages()[out.getPageCount()-1];
    const col = idx % 2; const row = Math.floor(idx / 2);
    const x0 = margin + col * (cellW + gap);
    const yTop = pageH - margin - row * (cellH + gap);
    const scale = Math.min(cellW / embedded.width, cellH / embedded.height);
    const drawW = embedded.width * scale; const drawH = embedded.height * scale;
    const x = x0 + (cellW - drawW) / 2;
    const y = yTop - cellH + (cellH - drawH) / 2;
    page.drawPage(embedded,{x,y,width:drawW,height:drawH});
    placed++;
  }
  const bytes = await out.save({ useObjectStreams:true });
  const path = safeOutputPath(submissionId);
  const { error: uploadError } = await adminClient.storage.from('printflow-output').upload(path, bytes, { contentType:'application/pdf', upsert:true });
  if (uploadError) throw new Error(`Could not save print-ready PDF: ${uploadError.message}`);
  const { error: updateError } = await adminClient.from('submissions').update({ status:'ready', output_path:path, output_card_count:placed, output_page_count:Math.ceil(placed/4), processed_at:new Date().toISOString(), notes:null, updated_at:new Date().toISOString() }).eq('id',submissionId);
  if (updateError) throw updateError;
  return { referenceCode:submission.reference_code, cardCount:placed, pageCount:Math.ceil(placed/4), outputPath:path };
}

const activeJobs = new Set();
app.post('/process', async (req,res) => {
  let profile;
  try { profile = await authorizeAdmin(req); }
  catch (err) { return res.status(403).json({ error:err.message }); }
  const submissionId = req.body?.submissionId;
  if (typeof submissionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(submissionId)) return res.status(400).json({ error:'A valid submissionId is required.' });
  if (activeJobs.has(submissionId)) return res.status(409).json({ error:'This submission is already being processed.' });
  const { data: sub, error } = await adminClient.from('submissions').select('id,status').eq('id',submissionId).single();
  if (error || !sub) return res.status(404).json({ error:'Submission not found.' });
  if (sub.status === 'processing') return res.status(409).json({ error:'This submission is already marked as processing.' });
  const { error: markError } = await adminClient.from('submissions').update({ status:'processing', notes:null }).eq('id',submissionId);
  if (markError) return res.status(500).json({ error:`Could not start job: ${markError.message}` });
  activeJobs.add(submissionId);
  res.status(202).json({ accepted:true, submissionId, message:'PDF processing has started. Refresh the submissions list to check its status.' });
  // Process in the persistent worker process after responding, avoiding a long HTTP request timeout.
  void buildPrintPdf(submissionId).catch(async err => { console.error('PDF processing failed', submissionId, err); await setFailed(submissionId, err?.message || 'Unknown processing error'); }).finally(() => activeJobs.delete(submissionId));
});

app.listen(PORT, () => console.log(`MADARA PRINTFLOW worker listening on ${PORT}`));
