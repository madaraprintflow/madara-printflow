import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { supabase, configReady, workerUrl } from './supabase';
import { FileArchive, FileText, FolderOpen, LogOut, Printer, RefreshCw, ShieldCheck, UploadCloud, Users, ChartNoAxesColumn, CheckCircle2, Clock3, AlertCircle, Download, Eye, Plus, X } from 'lucide-react';

type Profile = { id: string; full_name: string; role: 'admin' | 'agent'; agent_code: string | null; is_active: boolean };
type Submission = { id: string; reference_code: string; agent_id: string; town: string; community: string; ward: string; state: string; report_month: string; area: string; batch: string; card_count: number; file_count: number; status: string; output_path: string | null; output_page_count: number | null; submitted_at: string; processed_at: string | null; profiles?: { full_name: string; agent_code: string | null } };
type PdfInput = { file: File; name: string };
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const monthValue = (v: string) => `${v}-01`;
const niceDate = (v?: string | null) => v ? new Date(v).toLocaleDateString() : '—';
const niceBytes = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function App() {
  const [session, setSession] = useState<any>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState<'login'|'register'>('login');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [fullName, setFullName] = useState('');
  const [authError, setAuthError] = useState(''); const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'overview'|'upload'|'submissions'|'reports'|'agents'>('overview');
  const [submissions, setSubmissions] = useState<Submission[]>([]); const [agents, setAgents] = useState<Profile[]>([]); const [busy, setBusy] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().slice(0,7));
  const [form, setForm] = useState({ town:'', community:'', ward:'', state:'Kano', report_month:new Date().toISOString().slice(0,7), area:'', batch:'' });
  const [inputs, setInputs] = useState<PdfInput[]>([]); const [fileError, setFileError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null); const folderRef = useRef<HTMLInputElement>(null); const zipRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); if (data.session) void loadProfile(data.session.user.id); else setLoading(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) { setLoading(true); window.setTimeout(() => void loadProfile(nextSession.user.id), 0); }
      else { setProfile(null); setSubmissions([]); setAgents([]); setLoading(false); }
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  async function loadProfile(userId: string) {
    const { data, error } = await supabase.from('profiles').select('id,full_name,role,agent_code,is_active').eq('id', userId).single();
    if (error || !data) { setAuthError('Your profile could not be loaded. Check that setup.sql was run in Supabase.'); setLoading(false); return; }
    if (!data.is_active) { await supabase.auth.signOut(); setAuthError('This account is disabled. Contact the administrator.'); setLoading(false); return; }
    setProfile(data as Profile); setLoading(false); await refreshData(data as Profile);
  }

  async function refreshData(p = profile) {
    if (!p) return;
    setBusy(true);
    const query = supabase.from('submissions').select('*, profiles:profiles!submissions_agent_id_fkey(full_name,agent_code)').order('submitted_at', { ascending: false }).limit(1000);
    const { data, error } = p.role === 'admin' ? await query : await supabase.from('submissions').select('*').eq('agent_id', p.id).order('submitted_at', { ascending: false }).limit(300);
    if (error) setNotice(`Could not load submissions: ${error.message}`); else setSubmissions((data || []) as Submission[]);
    if (p.role === 'admin') {
      const { data: people, error: agentError } = await supabase.from('profiles').select('id,full_name,role,agent_code,is_active').order('created_at', { ascending: false });
      if (!agentError) setAgents((people || []) as Profile[]);
    }
    setBusy(false);
  }

  async function handleAuth(e: FormEvent) {
    e.preventDefault(); setAuthError(''); setNotice(''); setBusy(true);
    if (authMode === 'register') {
      const { error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName } } });
      if (error) setAuthError(error.message); else setNotice('Account created. If email confirmation is enabled, confirm your email before logging in. New accounts are agents by default.');
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password }); if (error) setAuthError(error.message);
    }
    setBusy(false);
  }

  function addFiles(files: FileList | File[]) {
    setFileError('');
    const next = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.pdf')).map(file => ({ file, name: file.name }));
    if (!next.length) { setFileError('No PDF files found. If uploading a ZIP, use the ZIP upload button.'); return; }
    setInputs(old => { const seen = new Set(old.map(x => `${x.name}:${x.file.size}:${x.file.lastModified}`)); const combined = [...old]; for (const item of next) { const key = `${item.name}:${item.file.size}:${item.file.lastModified}`; if (!seen.has(key)) { combined.push(item); seen.add(key); } } return combined; });
  }

  async function addZip(files: FileList | null) {
    if (!files?.length) return; setBusy(true); setFileError('');
    try {
      const zip = await JSZip.loadAsync(files[0]); const found: PdfInput[] = [];
      const entries = Object.values(zip.files).filter(f => !f.dir && f.name.toLowerCase().endsWith('.pdf'));
      for (const entry of entries) { const blob = await entry.async('blob'); const safeName = entry.name.split('/').filter(Boolean).pop() || 'card.pdf'; found.push({ file: new File([blob], safeName, { type:'application/pdf' }), name: safeName }); }
      if (!found.length) setFileError('The ZIP archive did not contain any PDF files.'); else setInputs(old => [...old, ...found]);
    } catch { setFileError('The ZIP file could not be opened. Please check that it is a valid ZIP archive.'); }
    setBusy(false); if (zipRef.current) zipRef.current.value = '';
  }

  async function submitBatch(e: FormEvent) {
    e.preventDefault(); if (!profile || !inputs.length) { setFileError('Select at least one PDF or ZIP containing PDFs.'); return; }
    if (inputs.length > 2500) { setFileError('This batch contains more than 2,500 PDFs. Split it into smaller submissions to improve reliability.'); return; }
    setBusy(true); setFileError(''); setNotice('Creating submission…');
    try {
      const { data: sub, error: createError } = await supabase.from('submissions').insert({ agent_id: profile.id, ...form, report_month: monthValue(form.report_month), status:'submitted' }).select('*').single();
      if (createError || !sub) throw createError || new Error('Could not create submission.');
      let done = 0;
      for (const item of inputs) {
        const safeName = item.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-150) || 'card.pdf';
        const path = `${profile.id}/${sub.id}/${String(done + 1).padStart(5,'0')}-${crypto.randomUUID()}-${safeName}`;
        const { error: uploadError } = await supabase.storage.from('printflow-originals').upload(path, item.file, { contentType:'application/pdf', upsert:false });
        if (uploadError) throw new Error(`Upload failed for ${item.name}: ${uploadError.message}`);
        const { error: rowError } = await supabase.from('submission_files').insert({ submission_id: sub.id, agent_id: profile.id, original_name:item.name, storage_path:path, mime_type:'application/pdf', file_size_bytes:item.file.size });
        if (rowError) throw new Error(`File record failed for ${item.name}: ${rowError.message}`);
        done++; setNotice(`Uploading PDF ${done} of ${inputs.length}…`);
      }
      setInputs([]); setForm(f => ({ ...f, town:'', community:'', ward:'', area:'', batch:'' })); setNotice(`Submission received: ${sub.reference_code}. ${done} PDFs uploaded.`); setTab('submissions'); await refreshData(profile);
    } catch (err: any) { setFileError(err?.message || 'Submission failed.'); setNotice(''); }
    setBusy(false);
  }

  async function processSubmission(sub: Submission) {
    if (!workerUrl) { setNotice('Worker URL is missing. Configure VITE_PRINT_WORKER_URL in Netlify environment variables.'); return; }
    const { data: { session: current } } = await supabase.auth.getSession(); if (!current) return;
    setBusy(true); setNotice(`Starting PDF processing for ${sub.reference_code}…`);
    try {
      const response = await fetch(`${workerUrl}/process`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${current.access_token}` }, body:JSON.stringify({ submissionId:sub.id }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Processing request failed.');
      setNotice(`Processing started for ${sub.reference_code}. Refresh the list to check its status; large batches may take several minutes.`); await refreshData(profile);
    } catch (err:any) { setNotice(`Processing failed: ${err?.message || 'Unknown error'}`); }
    setBusy(false);
  }

  async function downloadOutput(sub: Submission) {
    if (!sub.output_path) return;
    const { data, error } = await supabase.storage.from('printflow-output').createSignedUrl(sub.output_path, 60 * 10);
    if (error || !data?.signedUrl) { setNotice(`Could not create download link: ${error?.message || 'unknown error'}`); return; }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  }

  async function downloadOriginals(sub: Submission, asZip: boolean) {
    setBusy(true);
    setNotice(asZip ? `Preparing original PDF ZIP for ${sub.reference_code}…` : `Preparing original PDFs for ${sub.reference_code}…`);
    try {
      const { data: rows, error } = await supabase.from('submission_files')
        .select('original_name,storage_path')
        .eq('submission_id', sub.id)
        .order('created_at', { ascending: true });
      if (error) throw error;
      if (!rows?.length) throw new Error('No original PDF files were found for this submission.');

      const archive = asZip ? new JSZip() : null;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const { data, error: downloadError } = await supabase.storage.from('printflow-originals').download(row.storage_path);
        if (downloadError || !data) throw new Error(`Could not download ${row.original_name}: ${downloadError?.message || 'file unavailable'}`);
        const safeName = (row.original_name || `card-${i + 1}.pdf`).split('/').pop() || `card-${i + 1}.pdf`;
        if (archive) {
          archive.file(`${String(i + 1).padStart(5, '0')}-${safeName}`, data);
        } else {
          const url = URL.createObjectURL(data);
          const link = document.createElement('a');
          link.href = url;
          link.download = safeName;
          document.body.appendChild(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 15000);
        }
        setNotice(`Preparing original files: ${i + 1} of ${rows.length}…`);
      }
      if (archive) {
        const blob = await archive.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${sub.reference_code}-original-pdfs.zip`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 15000);
      }
      setNotice(asZip
        ? `Original PDF ZIP downloaded for ${sub.reference_code}.`
        : `Original PDF downloads started for ${sub.reference_code}. Your browser may ask permission for multiple downloads.`);
    } catch (err: any) {
      setNotice(`Original file download failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setBusy(false);
    }
  }

  async function markPrinted(sub: Submission) {
    const { error } = await supabase.from('submissions').update({ status:'printed', printed_at:new Date().toISOString() }).eq('id', sub.id);
    if (error) setNotice(`Could not mark printed: ${error.message}`); else { setNotice(`${sub.reference_code} marked as printed.`); await refreshData(profile); }
  }

  async function changeAgentActive(agent: Profile) {
    const { error } = await supabase.from('profiles').update({ is_active:!agent.is_active }).eq('id', agent.id);
    if (error) setNotice(`Could not update agent: ${error.message}`); else { setNotice(`${agent.full_name || 'Agent'} ${agent.is_active ? 'disabled' : 'enabled'}.`); await refreshData(profile); }
  }

  async function logout() { await supabase.auth.signOut(); }
  const monthSubmissions = useMemo(() => submissions.filter(s => s.report_month?.slice(0,7) === selectedMonth), [submissions, selectedMonth]);
  const totalCards = submissions.reduce((n,s) => n + (s.card_count || 0), 0);
  const pending = submissions.filter(s => ['submitted','processing','failed'].includes(s.status)).length;
  const ready = submissions.filter(s => ['ready','printed'].includes(s.status)).length;
  const reportRows = useMemo(() => { const map = new Map<string, { name:string; code:string; cards:number; batches:number }>(); for (const s of monthSubmissions) { const key=s.agent_id; const existing=map.get(key) || {name:s.profiles?.full_name || (s.agent_id===profile?.id ? profile.full_name : 'Agent'), code:s.profiles?.agent_code || '', cards:0, batches:0}; existing.cards += s.card_count || 0; existing.batches++; map.set(key,existing); } return [...map.values()].sort((a,b)=>a.name.localeCompare(b.name)); }, [monthSubmissions, profile]);

  if (!configReady) return <div className="setup-screen"><div className="brand-mark">MP</div><h1>MADARA PRINTFLOW</h1><p className="muted">Bulk PDF Processing & Card Printing Management</p><div className="setup-card"><h2>Configuration required</h2><p>Add your Supabase project URL and anon/publishable key to a local <code>.env.local</code> file, or configure them as Netlify environment variables.</p><p>See <code>DEPLOYMENT.md</code> in the project ZIP for exact steps. Do not put the Supabase service-role key in the frontend.</p></div></div>;
  if (loading) return <div className="loading-screen"><div className="spinner"/><span>Loading MADARA PRINTFLOW…</span></div>;
  if (!session || !profile) return <div className="auth-screen"><div className="auth-hero"><div className="brand-mark">MP</div><div className="eyebrow">MADARA GROUP · DOCUMENT WORKFLOW</div><h1>Every card.<br/><span>Ready to print.</span></h1><p>Collect agent submissions, download original PDFs individually or as a ZIP, and optionally prepare print-ready A4 sheets.</p><div className="hero-points"><span><ShieldCheck size={16}/> Secure agent access</span><span><Printer size={16}/> 4 cards per A4 sheet</span><span><ChartNoAxesColumn size={16}/> Monthly card reports</span></div></div><div className="auth-panel"><div className="auth-box"><div className="eyebrow">WORKSPACE ACCESS</div><h2>{authMode==='login'?'Welcome back':'Create agent account'}</h2><p className="muted">{authMode==='login'?'Sign in to continue to your workspace.':'New accounts are created with agent access.'}</p><form onSubmit={handleAuth} className="stack-form">{authMode==='register' && <label>Full name<input value={fullName} onChange={e=>setFullName(e.target.value)} required placeholder="Agent full name"/></label>}<label>Email address<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required placeholder="you@example.com" autoComplete="email"/></label><label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={8} placeholder="At least 8 characters" autoComplete={authMode==='login'?'current-password':'new-password'}/></label>{authError && <div className="alert error"><AlertCircle size={16}/>{authError}</div>}{notice && <div className="alert success">{notice}</div>}<button className="primary-btn full" disabled={busy}>{busy?'Please wait…':authMode==='login'?'Sign in':'Create account'}</button></form><div className="auth-switch">{authMode==='login'?"Agent account not created yet?":"Already registered?"} <button className="text-btn" onClick={()=>{setAuthMode(authMode==='login'?'register':'login');setAuthError('');setNotice('');}}>{authMode==='login'?'Register':'Sign in'}</button></div><p className="tiny-note">Administrator access must be enabled by the project owner in Supabase.</p></div></div></div>;

  const isAdmin = profile.role === 'admin';
  const nav = [ {id:'overview',label:'Overview',icon:ChartNoAxesColumn}, ...(isAdmin?[{id:'agents',label:'Agents',icon:Users}]:[]), {id:'upload',label:'New submission',icon:UploadCloud}, {id:'submissions',label:'Submissions',icon:FileText}, ...(isAdmin?[{id:'reports',label:'Monthly reports',icon:Printer}]:[]) ] as const;
  const statuses: Record<string,string> = {submitted:'Submitted',processing:'Processing',ready:'Ready to print',printed:'Printed',failed:'Failed'};
  return <div className="app-shell"><aside className="sidebar"><div className="side-brand"><div className="brand-mark small">MP</div><div><strong>MADARA</strong><span>PRINTFLOW</span></div></div><div className="workspace-label">WORKSPACE</div><nav>{nav.map(item=>{const Icon=item.icon;return <button key={item.id} className={`nav-item ${tab===item.id?'active':''}`} onClick={()=>setTab(item.id as any)}><Icon size={18}/><span>{item.label}</span></button>;})}</nav><div className="sidebar-bottom"><div className="profile-mini"><div className="avatar">{(profile.full_name||'A').slice(0,1).toUpperCase()}</div><div className="profile-mini-text"><strong>{profile.full_name||'User'}</strong><span>{isAdmin?'Administrator':'Agent account'}</span></div></div><button className="nav-item logout" onClick={logout}><LogOut size={18}/><span>Sign out</span></button></div></aside><main className="main-area"><header className="topbar"><div><div className="breadcrumb">Workspace <span>/</span> {nav.find(n=>n.id===tab)?.label || 'Overview'}</div><h1>{tab==='overview'?'Overview':tab==='upload'?'New submission':tab==='submissions'?'Submissions':tab==='reports'?'Monthly reports':'Agent management'}</h1></div><div className="topbar-actions"><span className={`role-pill ${isAdmin?'admin':'agent'}`}>{isAdmin?'ADMINISTRATOR':'AGENT'}</span><button className="icon-btn" title="Refresh" onClick={()=>void refreshData()} disabled={busy}><RefreshCw size={17}/></button></div></header>{notice && <div className="notice-bar"><span>{notice}</span><button onClick={()=>setNotice('')} aria-label="Dismiss"><X size={15}/></button></div>}
  {tab==='overview' && <section className="content"><div className="welcome-row"><div><div className="eyebrow">YOUR PRINT WORKSPACE</div><h2>{isAdmin?'Good to have you back.':'Welcome to your workspace.'}</h2><p className="muted">{isAdmin?'Monitor submissions, processing and monthly card totals.':'Upload card PDFs and track your submissions here.'}</p></div>{isAdmin&&<button className="primary-btn" onClick={()=>setTab('reports')}><Printer size={16}/> Monthly reports</button>}</div><div className="stats-grid"><Stat icon={FileText} label={isAdmin?'Total submissions':'Your submissions'} value={String(submissions.length)} detail="Recorded submissions"/><Stat icon={FileArchive} label="Cards submitted" value={totalCards.toLocaleString()} detail="Counted from PDF records"/><Stat icon={Clock3} label="Awaiting action" value={String(pending)} detail="Submitted, processing or failed"/><Stat icon={CheckCircle2} label="Ready / printed" value={String(ready)} detail="Completed print jobs"/></div><div className="section-heading"><div><h3>Recent submissions</h3><p>Latest activity in your workspace</p></div><button className="outline-btn" onClick={()=>setTab('submissions')}>View all <span>→</span></button></div><SubmissionTable rows={submissions.slice(0,6)} isAdmin={isAdmin} busy={busy} onProcess={processSubmission} onDownload={downloadOutput} onDownloadOriginals={downloadOriginals} onPrinted={markPrinted}/><div className="tip-card"><div className="tip-icon"><Printer size={19}/></div><div><strong>Print layout</strong><p>Original PDFs can be downloaded individually or together as a ZIP. Print-ready A4 sheets (four cards per page) are optional.</p></div></div></section>}
  {tab==='upload' && <section className="content narrow-content"><div className="page-intro"><div className="eyebrow">AGENT SUBMISSION</div><h2>Submit and manage a batch</h2><p className="muted">Enter the batch details and add PDFs directly, from a ZIP, or from a folder. Original PDFs remain available to download; A4 formatting is optional.</p></div><form onSubmit={submitBatch} className="submission-form"><div className="form-section-title"><span>01</span><div><h3>Batch information</h3><p>Tell us where these cards belong.</p></div></div><div className="form-grid"><label>Town *<input required value={form.town} onChange={e=>setForm({...form,town:e.target.value})} placeholder="Enter town"/></label><label>Community *<input required value={form.community} onChange={e=>setForm({...form,community:e.target.value})} placeholder="Enter community"/></label><label>Ward *<input required value={form.ward} onChange={e=>setForm({...form,ward:e.target.value})} placeholder="Enter ward"/></label><label>State *<select required value={form.state} onChange={e=>setForm({...form,state:e.target.value})}>{['Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno','Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','FCT Abuja','Gombe','Imo','Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara','Lagos','Nasarawa','Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers','Sokoto','Taraba','Yobe','Zamfara'].map(s=><option key={s}>{s}</option>)}</select></label><label>Area *<input required value={form.area} onChange={e=>setForm({...form,area:e.target.value})} placeholder="Enter area"/></label><label>Batch *<input required value={form.batch} onChange={e=>setForm({...form,batch:e.target.value})} placeholder="e.g. BATCH-001"/></label><label>Reporting month *<input type="month" required value={form.report_month} onChange={e=>setForm({...form,report_month:e.target.value})}/></label></div><div className="form-section-title upload-title"><span>02</span><div><h3>Card PDF files</h3><p>One PDF should contain one card. PDF files are counted after upload.</p></div></div><div className="upload-options"><button type="button" className="upload-option" onClick={()=>fileRef.current?.click()}><div className="upload-option-icon"><FileText size={21}/></div><strong>Select PDFs</strong><span>One or many PDF files</span></button><button type="button" className="upload-option" onClick={()=>zipRef.current?.click()}><div className="upload-option-icon"><FileArchive size={21}/></div><strong>Select ZIP</strong><span>Extract PDFs from an archive</span></button><button type="button" className="upload-option" onClick={()=>folderRef.current?.click()}><div className="upload-option-icon"><FolderOpen size={21}/></div><strong>Select folder</strong><span>Collect PDFs in a folder</span></button><input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={e=>{if(e.target.files)addFiles(e.target.files);e.currentTarget.value='';}}/><input ref={zipRef} type="file" accept=".zip,application/zip" hidden onChange={e=>void addZip(e.target.files)}/><input ref={folderRef} type="file" accept="application/pdf,.pdf" multiple hidden {...({webkitdirectory:'',directory:''} as any)} onChange={e=>{if(e.target.files)addFiles(e.target.files);e.currentTarget.value='';}}/></div>{fileError&&<div className="alert error"><AlertCircle size={16}/>{fileError}</div>}{inputs.length>0&&<div className="selected-files"><div className="selected-files-head"><div><strong>{inputs.length.toLocaleString()} PDF files selected</strong><span>Estimated upload size: {niceBytes(inputs.reduce((n,x)=>n+x.file.size,0))}</span></div><button type="button" className="text-btn danger-text" onClick={()=>setInputs([])}>Clear all</button></div><div className="file-list">{inputs.slice(0,5).map((f,i)=><div className="file-row" key={`${f.name}-${i}`}><FileText size={16}/><span>{f.name}</span><small>{niceBytes(f.file.size)}</small></div>)}{inputs.length>5&&<div className="more-files">+ {inputs.length-5} more files</div>}</div></div>}<div className="upload-footer"><div><strong>{inputs.length.toLocaleString()} cards expected</strong><span>1 PDF = 1 card. Final count is confirmed from uploaded files.</span></div><button className="primary-btn" disabled={busy||inputs.length===0}><UploadCloud size={17}/>{busy?'Submitting…':'Submit files'}</button></div></form></section>}
  {tab==='submissions' && <section className="content"><div className="section-heading"><div><h3>{isAdmin?'All submissions':'Your submissions'}</h3><p>{isAdmin?'Download original files or optionally generate print-ready A4 sheets.':'Review your submitted batches and current status.'}</p></div><button className="primary-btn" onClick={()=>setTab('upload')}><Plus size={17}/> New submission</button></div><SubmissionTable rows={submissions} isAdmin={isAdmin} busy={busy} onProcess={processSubmission} onDownload={downloadOutput} onDownloadOriginals={downloadOriginals} onPrinted={markPrinted}/></section>}
  {tab==='reports' && isAdmin && <section className="content"><div className="page-intro report-intro"><div><div className="eyebrow">ADMINISTRATOR ONLY</div><h2>Monthly card calculations</h2><p className="muted">Monthly totals are visible only to administrators.</p></div><label className="month-filter">Reporting month<input type="month" value={selectedMonth} onChange={e=>setSelectedMonth(e.target.value)}/></label></div><div className="report-summary"><div><span>Cards submitted</span><strong>{monthSubmissions.reduce((n,s)=>n+s.card_count,0).toLocaleString()}</strong></div><div><span>Submissions</span><strong>{monthSubmissions.length.toLocaleString()}</strong></div><div><span>Agents active</span><strong>{reportRows.length.toLocaleString()}</strong></div><div><span>A4 sheets estimated</span><strong>{Math.ceil(monthSubmissions.reduce((n,s)=>n+s.card_count,0)/4).toLocaleString()}</strong></div></div><div className="section-heading"><div><h3>Agent monthly totals</h3><p>{MONTHS[Number(selectedMonth.slice(5,7))-1]} {selectedMonth.slice(0,4)}</p></div><div className="button-row"><button className="outline-btn" onClick={()=>exportCsv(reportRows,selectedMonth)}><Download size={15}/> Export Excel-compatible CSV</button><button className="primary-btn" onClick={()=>window.print()}><Printer size={16}/> Print report</button></div></div><div className="table-wrap"><table><thead><tr><th>Agent</th><th>Agent code</th><th>Submissions</th><th>Total cards</th><th>Estimated A4 sheets</th></tr></thead><tbody>{reportRows.map((r,i)=><tr key={`${r.name}-${i}`}><td><strong>{r.name}</strong></td><td>{r.code||'—'}</td><td>{r.batches}</td><td className="number-cell">{r.cards.toLocaleString()}</td><td className="number-cell">{Math.ceil(r.cards/4).toLocaleString()}</td></tr>)}{!reportRows.length&&<tr><td colSpan={5} className="empty-cell">No submissions found for this month.</td></tr>}</tbody><tfoot><tr><td colSpan={2}>TOTAL</td><td>{monthSubmissions.length}</td><td className="number-cell">{monthSubmissions.reduce((n,s)=>n+s.card_count,0).toLocaleString()}</td><td className="number-cell">{Math.ceil(monthSubmissions.reduce((n,s)=>n+s.card_count,0)/4).toLocaleString()}</td></tr></tfoot></table></div><div className="section-heading subheading"><div><h3>Submission detail</h3><p>Records included in this monthly report.</p></div></div><SubmissionTable rows={monthSubmissions} isAdmin busy={busy} onProcess={processSubmission} onDownload={downloadOutput} onDownloadOriginals={downloadOriginals} onPrinted={markPrinted}/></section>}
  {tab==='agents' && isAdmin && <section className="content"><div className="section-heading"><div><h3>Agent accounts</h3><p>Accounts register automatically when users sign up. New accounts are agents by default.</p></div><button className="outline-btn" onClick={()=>void refreshData()}><RefreshCw size={15}/> Refresh</button></div><div className="table-wrap"><table><thead><tr><th>Agent</th><th>Agent code</th><th>Role</th><th>Access</th><th>Joined</th><th>Action</th></tr></thead><tbody>{agents.map(a=><tr key={a.id}><td><div className="agent-cell"><div className="avatar small-avatar">{(a.full_name||'A').slice(0,1).toUpperCase()}</div><div><strong>{a.full_name||'Unnamed agent'}</strong><small>{a.id.slice(0,8)}…</small></div></div></td><td>{a.agent_code||'—'}</td><td><span className={`role-pill ${a.role}`}>{a.role}</span></td><td><span className={`access-state ${a.is_active?'enabled':'disabled'}`}>{a.is_active?'Active':'Disabled'}</span></td><td>—</td><td>{a.id===profile.id?<span className="muted">You</span>:<button className="outline-btn compact" onClick={()=>void changeAgentActive(a)}>{a.is_active?'Disable':'Enable'}</button>}</td></tr>)}</tbody></table></div><div className="tip-card"><div className="tip-icon"><ShieldCheck size={19}/></div><div><strong>Promoting an administrator</strong><p>For security, assign administrator privileges through the Supabase SQL Editor. Never let agents change their own roles.</p></div></div></section>}
  <footer className="app-footer"><span>MADARA PRINTFLOW</span><span>Secure document workflow · v1.0</span></footer></main></div>;
}

function Stat({icon:Icon,label,value,detail}:{icon:any;label:string;value:string;detail:string}) { return <div className="stat-card"><div className="stat-top"><span>{label}</span><div className="stat-icon"><Icon size={18}/></div></div><strong className="stat-value">{value}</strong><span className="stat-detail">{detail}</span></div>; }
function SubmissionTable({rows,isAdmin,busy,onProcess,onDownload,onDownloadOriginals,onPrinted}:{rows:Submission[];isAdmin:boolean;busy:boolean;onProcess:(s:Submission)=>void;onDownload:(s:Submission)=>void;onDownloadOriginals:(s:Submission,asZip:boolean)=>void;onPrinted:(s:Submission)=>void}) {
  const statusClass = (s:string) => ['ready','printed'].includes(s)?'done':s==='failed'?'failed':s==='processing'?'working':'pending';
  return <div className="table-wrap"><table><thead><tr><th>Reference / Agent</th><th>Location & batch</th><th>Month</th><th>Cards</th><th>Status</th><th>Submitted</th><th>Actions</th></tr></thead><tbody>{rows.map(s=><tr key={s.id}><td><strong>{s.reference_code}</strong><small className="cell-sub">{isAdmin?(s.profiles?.full_name||'Agent'):''}</small></td><td><strong>{s.town}</strong><small className="cell-sub">{s.community} · {s.ward} · {s.area} · {s.batch}</small></td><td>{s.report_month?new Date(`${s.report_month.slice(0,7)}-02T12:00:00`).toLocaleDateString(undefined,{month:'short',year:'numeric'}):'—'}</td><td><strong>{(s.card_count||0).toLocaleString()}</strong><small className="cell-sub">{Math.ceil((s.card_count||0)/4)} A4 sheets</small></td><td><span className={`status-pill ${statusClass(s.status)}`}><span className="status-dot"/>{s.status==='ready'?'Ready to print':s.status==='printed'?'Printed':s.status==='processing'?'Processing':s.status==='failed'?'Failed':'Submitted'}</span></td><td>{niceDate(s.submitted_at)}</td><td><div className="action-buttons"><button title="Download original PDFs individually" className="icon-action" disabled={busy||!s.file_count} onClick={()=>onDownloadOriginals(s,false)}><FileText size={16}/></button><button title="Download all original PDFs as ZIP" className="icon-action" disabled={busy||!s.file_count} onClick={()=>onDownloadOriginals(s,true)}><FileArchive size={16}/></button>{isAdmin&&['submitted','failed'].includes(s.status)&&<button title="Optional: generate print-ready A4 PDF" className="icon-action" disabled={busy||!s.card_count} onClick={()=>onProcess(s)}><Printer size={16}/></button>}{isAdmin&&s.output_path&&<button title="Download print-ready PDF" className="icon-action" onClick={()=>onDownload(s)}><Download size={16}/></button>}{isAdmin&&s.status==='ready'&&<button title="Mark printed" className="icon-action success-action" onClick={()=>onPrinted(s)}><CheckCircle2 size={16}/></button>}</div></td></tr>)}{!rows.length&&<tr><td colSpan={7} className="empty-cell">{busy?'Loading submissions…':'No submissions yet.'}</td></tr>}</tbody></table></div>;
}
function exportCsv(rows:{name:string;code:string;cards:number;batches:number}[],month:string) { const content=[['Agent','Agent code','Submissions','Cards','Estimated A4 sheets'],...rows.map(r=>[r.name,r.code,r.batches,r.cards,Math.ceil(r.cards/4)]),['TOTAL','',rows.reduce((n,r)=>n+r.batches,0),rows.reduce((n,r)=>n+r.cards,0),Math.ceil(rows.reduce((n,r)=>n+r.cards,0)/4)]].map(row=>row.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n'); const blob=new Blob(['\ufeff',content],{type:'text/csv;charset=utf-8;'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`madara-printflow-monthly-${month}.csv`; a.click(); URL.revokeObjectURL(url); }
