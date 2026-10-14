# Deployment quick guide

Follow the detailed instructions in `README.md`.

1. Run `supabase/setup.sql` in the MADARA PRINTFLOW Supabase project's SQL Editor.
2. Deploy `worker/` as a persistent Node.js service and configure its server-only Supabase credentials.
3. Deploy the project root to Netlify with `npm run build` and publish directory `dist`.
4. Configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_PRINT_WORKER_URL` in Netlify.
5. Register your account, promote it to administrator using the SQL in README, and test with sample PDFs before production use.
