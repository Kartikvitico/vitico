# VITICO Wholesale

A B2B wholesale ordering platform: a web app (`web/`) on a Supabase database (`supabase/`).

## What is in here

| Path | What it is |
|---|---|
| `supabase/schema.sql` | The database: tables, security rules, and the pricing, ordering, Deal Drop and approval logic |
| `supabase/sample_products.sql` | Optional sample products for testing |
| `web/` | The website: `index.html`, `app.js`, `config.js`, `logo.png`. No build step |

## Set up (about 20 minutes)

1. **Create a Supabase project** at supabase.com. Pick the region closest to Fiji (Sydney).
2. **Create the database.** In the dashboard open SQL Editor, paste all of `supabase/schema.sql`, and run it once.
   To start with sample products, run `supabase/sample_products.sql` the same way.
3. **Connect the website.** Open `web/config.js` and paste:
   - your project URL (`https://xxxx.supabase.co`), shown in the project's Connect dialog
   - your **publishable** key from Settings > API Keys (on older projects this is the `anon` key)

   Never put the secret / `service_role` key in this file.
4. **Put the website online.** Upload the four files in `web/` to any static host (Netlify, Vercel,
   Cloudflare Pages, or your own server). To try it on your computer first, run `npx serve web`.
5. **Tell Supabase the site address.** Authentication > URL Configuration: set Site URL to your
   website address, so confirmation and password-reset emails link back to it.
6. **Create the first admin.**
   - Authentication > Users > Add user (your email and a password).
   - SQL Editor: `update public.profiles set role = 'admin' where email = 'you@example.com';`
   - Log in on the website. You now see the admin screens.
7. **Add sales reps and more admins.** Add each person under Authentication > Users, then on the website
   go to Customers and users > Logins and set their type.

Customers create their own login through "Apply for a trade account". You approve them under
Customers and users, then set their tier, credit limit and sales rep.

## How it works

- **Prices** are worked out in one database function (`app.price_calc`): contract price, or standard price
  with tier and zone, then quantity breaks and promotions. The website only displays what it returns, and
  the price is recalculated in the database when an order is placed.
- **Orders, stock, credit, the rebate wallet and Deal Drop allocations** change only inside database
  functions (`place_order`, `secure_deal`, `set_order_status`), each in a single transaction with row locks,
  so two buyers cannot take the same stock or the same deal allocation.
- **Security** is row level security: a customer can read only their own company's data, a rep only
  their assigned customers, and only admins can change settings.

## What is not built yet

- **Payments.** M-PAiSA and bank deposit orders are recorded as "Awaiting payment" and an admin marks them
  paid. There is no payment gateway connection.
- **Zoho.** No sync with Zoho Books, Inventory or CRM. The `invoices` table is ready for a sync to fill;
  until then the customer's Invoices list is empty and the outstanding balance is kept in this database.
- **Order approval inside a customer's company.** Roles and the "can approve" flag are stored, but every
  linked user can place orders.
- **Quarter rollover.** Quarter spend does not reset by itself, and the target rebate is paid by an admin
  as wallet credit.
- **Native mobile apps, reports, notifications (email/push).**

## Before real customers use it

- Set up your own email sender in Supabase (Authentication > Emails > SMTP). The built-in sender is only
  meant for testing.
- Replace the sample products and check every rate under Pricing rules.
- Have a developer review the setup and turn on database backups.

## How this was tested

The schema was loaded into Postgres 16 and exercised through PostgREST (the same API layer Supabase uses)
with the real website code: sign-up, approval, pricing, cart orders, credit limits, Deal Drops, container
orders, special price requests, approvals, cancellations and cross-customer privacy. Sign-in was simulated
in that test, so the email steps (confirmation, password reset) have not been run against a live Supabase
project.
