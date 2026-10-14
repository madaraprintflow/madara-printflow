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

const adminClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const anonClient = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const app = express();

app.disable('x-powered-by');

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'MADARA PRINTFLOW PDF worker'
  });
});

async function authorizeAdmin(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!token) {
    throw new Error(
      'Sign in as an administrator to process PDF batches.'
    );
  }

  const { data: userData, error: userError } =
    await anonClient.auth.getUser(token);

  if (userError || !userData?.user) {
    throw new Error(
      'Your session is invalid or expired. Please sign in again.'
    );
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
    throw new Error('Administrator permission is
