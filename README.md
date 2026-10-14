# MADARA PRINTFLOW

Bulk PDF Processing & Card Printing Management System. This is a standalone application; it does not modify DIGITAL NO HOW.

## Features in this starter release

- Supabase email/password authentication; new registrations become agents by default.
- Agent submission form: town, community, ward, state, area, batch and reporting month.
- Upload multiple PDFs, ZIP archives containing PDFs, or a folder of PDFs.
- Submission counts are recalculated by the database from uploaded PDF records.
- Administrator submission dashboard and administrator-only monthly totals.
- A4 portrait output with four first-pages (one card per PDF) per sheet in a 2 x 2 grid. The worker preserves each PDF page's aspect ratio and centers it in its cell.
- Private Supabase Storage for original and processed PDFs.
- Print monthly report and export an Excel-compatible CSV.

## Important limitations / behavior

- Each uploaded PDF is treated as one card and the **first page only** is placed in the output. If a PDF contains multiple cards/pages, split it first.
- Card pages are scaled proportionally to fit each quarter of A4. They are not stretched. Check a sample print before processing a production batch; if you require an exact physical card size, provide that measurement so the layout can be configured precisely.
- ZIP files are extracted in the browser. Large ZIPs can consume Chromebook memory; for very large archives, split into several smaller batches.
- The worker is a persistent Node service because jobs may take longer than a typical serverless request. It acknowledges a job, then processes it in the background. Keep the worker service running while jobs process.
- The CSV export opens in Excel. It is not a native `.xlsx` workbook.
- This source is prepared for deployment but must be configured with your Supabase project and tested with real sample PDFs before production use.

## Deploy 1 — Supabase database

1. Open the **MADARA PRINTFLOW** project in the Supabase dashboard.
2. Go to **SQL Editor** and create a new query.
3. Paste and run all of `supabase/setup.sql`.
4. In **Authentication → Providers → Email**, choose whether to require email confirmation. For smoother initial testing you may disable confirmation temporarily, then enable it before wider use.
5. Create your own account through the application registration page after the frontend is deployed, or create a user in Authentication.
6. Promote your account to administrator. In SQL Editor, replace the sample email and run:

   ```sql
   update public.profiles p
   set role = 'admin', full_name = 'MADARA PRINTFLOW ADMIN'
   from auth.users u
   where p.id = u.id and lower(u.email) = lower('YOUR-LOGIN-EMAIL');
   ```

7. Confirm the query updated one row. Never give the service-role key to agents or put it in the frontend.

## Deploy 2 — PDF worker service

The worker lives in `worker/`. Deploy it as a persistent Node.js web service (for example, a Render Web Service), not as a short-timeout serverless function.

1. Push this project to a private GitHub repository, or upload it to a Git provider you control.
2. Create a new web service and set **Root Directory** to `worker`.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add these environment variables in the worker host's service settings:
   - `SUPABASE_URL` — the project URL from Supabase → Project Settings → API.
   - `SUPABASE_ANON_KEY` — the publishable/anon key from Supabase → Project Settings → API.
   - `SUPABASE_SERVICE_ROLE_KEY` — the secret service-role key from Supabase → Project Settings → API. Store it only in the worker's secret environment settings.
   - `MAX_PDFS_PER_JOB` — `2500` (or a lower value based on worker memory).
   - `PORT` is usually assigned by the hosting provider; the service reads it automatically.
6. Deploy and open `https://YOUR-WORKER-HOST/health`. It should return JSON with `ok: true`.

The worker verifies the logged-in user's Supabase token and checks that the user is an active administrator before processing. It uses the service-role key only on the server.

## Deploy 3 — Frontend to Netlify

1. In Netlify, choose **Add new site → Import an existing project** and connect your repository.
2. Set base directory to the project root, build command to `npm run build`, and publish directory to `dist`.
3. Add these environment variables in Netlify site configuration:
   - `VITE_SUPABASE_URL` — your Supabase project URL.
   - `VITE_SUPABASE_ANON_KEY` — your Supabase publishable/anon key.
   - `VITE_PRINT_WORKER_URL` — the deployed worker base URL, without a trailing slash.
4. Deploy the site. If you update environment variables, trigger a fresh deploy.

For local development, copy `.env.example` to `.env.local`, fill in the three `VITE_` variables, then run `npm install` and `npm run dev`.

## First-run checklist

- Register an agent account and confirm it can log in.
- Promote your own account to `admin` using the SQL above.
- Confirm an agent cannot open the administrator monthly reports.
- Upload a small test set of 1, 4, 5, and 10 single-card PDFs.
- Verify the output page count is respectively 1, 1, 2, and 3 A4 pages.
- Inspect and physically print a sample at **100% / Actual Size** and disable “Fit to page” if your printer dialog offers it. Check the card's physical dimensions before production.
- Test a ZIP and a folder upload on the Chromebook.
- Confirm output downloads work only for authorized users.

## Security notes

- The Supabase service-role key is a secret. Never add it to `.env.local` for the frontend, Netlify environment variables, source code, or a public repository.
- Keep the repository private if it includes configuration or business-specific information.
- The SQL enables Row Level Security and private buckets. Review policies and run access tests before onboarding real agents.
- Admin monthly totals are only shown in the admin UI; underlying RLS still allows an agent to see their own individual submission records, but not other agents' records.
